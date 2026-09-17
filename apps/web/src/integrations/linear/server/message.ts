/**
 * Linear issue formatting utilities.
 */

import type { CommentCreatedEvent, EventData } from '@/lib/server/events/types'
import TurndownService from 'turndown'
import { truncate } from '@/lib/server/events/hook-utils'
import { buildPostUrl, getAuthorName } from '@/lib/server/integrations/message-utils'

type LinearMedia = {
  kind: 'image' | 'video'
  url: string
  label: string
}

const VIDEO_FILE_RE = /\.(?:m4v|mov|mp4|webm)(?:[?#]|$)/i
const LEGACY_HTML_RE = /<\/?(?:blockquote|br|div|h[1-6]|img|li|ol|p|pre|ul|video)\b/i

function absoluteMediaUrl(rawUrl: string, rootUrl: string): string {
  const url = rawUrl.trim().replace(/^<|>$/g, '')
  if (!url.startsWith('/')) return url
  try {
    return new URL(url, `${rootUrl.replace(/\/$/, '')}/`).toString()
  } catch {
    return url
  }
}

function attribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))
  return match?.[2] ?? ''
}

function fileName(url: string): string {
  try {
    const path = new URL(url, 'https://quackback.invalid').pathname
    return decodeURIComponent(path.split('/').pop() || 'recording')
  } catch {
    return 'recording'
  }
}

function safeAlt(raw: string): string {
  return raw.replace(/[\[\]\r\n]/g, ' ').trim()
}

function videoLabel(rawLabel: string, url: string): string {
  const label = safeAlt(rawLabel)
  return !label || label === url || label.startsWith('/') || /^https?:\/\//i.test(label)
    ? fileName(url)
    : label
}

/** Extract rich media before the legacy HTML-stripping step removes its tags. */
function extractMedia(content: string, rootUrl: string): LinearMedia[] {
  const media: LinearMedia[] = []
  const seen = new Set<string>()
  const add = (kind: LinearMedia['kind'], rawUrl: string, label: string) => {
    const url = absoluteMediaUrl(rawUrl, rootUrl)
    if (!url || seen.has(url)) return
    seen.add(url)
    media.push({ kind, url, label: safeAlt(label) })
  }

  for (const match of content.matchAll(/<(img|video)\b[^>]*>/gi)) {
    const tag = match[0]
    const kind = match[1].toLowerCase() === 'video' ? 'video' : 'image'
    add(kind, attribute(tag, 'src'), attribute(tag, kind === 'video' ? 'title' : 'alt'))
  }

  for (const match of content.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    add('image', match[2], match[1])
  }

  for (const match of content.matchAll(/(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    if (VIDEO_FILE_RE.test(match[2])) add('video', match[2], match[1])
  }

  return media
}

/** Make app-relative markdown assets fetchable by Linear's ingestion worker. */
function absolutizeMarkdownUrls(content: string, rootUrl: string): string {
  return content.replace(/(!?\[[^\]]*\]\()([^)\s]+)([^)]*\))/g, (_all, open, url, close) => {
    const absolute = absoluteMediaUrl(url, rootUrl)
    if (!VIDEO_FILE_RE.test(absolute) || open.startsWith('!')) {
      return `${open}${absolute}${close}`
    }
    const label = videoLabel(open.slice(1, open.indexOf(']')), absolute)
    return `![Video: ${label}](${absolute}${close.slice(0, -1)})`
  })
}

function mediaMarkdown(media: LinearMedia): string {
  if (media.kind === 'video') {
    return `![Video: ${videoLabel(media.label, media.url)}](${media.url})`
  }
  return `![${media.label || 'Screenshot'}](${media.url})`
}

/** Keep stored Markdown intact; convert only legacy HTML rows to Markdown. */
function normalizeLinearMarkdown(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n')
  if (!LEGACY_HTML_RE.test(normalized)) return normalized.trim()

  return new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })
    .turndown(normalized)
    .trim()
}

/** Preserve rich media even when the surrounding narrative must be truncated. */
function buildLinearRichText(content: string, rootUrl: string, maxLength: number): string {
  const media = extractMedia(content, rootUrl)
  const text = truncate(absolutizeMarkdownUrls(normalizeLinearMarkdown(content), rootUrl), maxLength)
  const omittedMedia = media.filter((item) => !text.includes(item.url)).map(mediaMarkdown)

  return [text, ...(omittedMedia.length > 0 ? ['', '**Attachments**', ...omittedMedia] : [])].join(
    '\n'
  )
}

/**
 * Build a Linear issue title and description from a post.created event.
 */
export function buildLinearIssueBody(
  event: EventData,
  rootUrl: string
): { title: string; description: string } {
  if (event.type !== 'post.created') {
    return { title: 'Feedback', description: '' }
  }

  const { post } = event.data
  const postUrl = buildPostUrl(rootUrl, post.boardSlug, post.id)
  // Post writes are capped at 10,000 characters, so this keeps the complete
  // feedback narrative while still bounding the external API payload.
  const content = buildLinearRichText(post.content, rootUrl, 10_000)
  const author = getAuthorName(post)

  const description = [
    content,
    '',
    '---',
    `**Submitted by:** ${author}`,
    `**Board:** ${post.boardSlug}`,
    `[View in Quackback](${postUrl})`,
  ].join('\n')

  return { title: post.title, description }
}

/** Build the Linear body for a newly published public Quackback comment. */
export function buildLinearCommentBody(event: CommentCreatedEvent, rootUrl: string): string {
  const { comment, post } = event.data
  const author = getAuthorName(comment)
  const content = buildLinearRichText(comment.content, rootUrl, 5000)
  const commentUrl = `${buildPostUrl(rootUrl, post.boardSlug, post.id)}#comment-${comment.id}`

  return [
    `**${author} commented:**`,
    '',
    content,
    '',
    `[View comment in Quackback](${commentUrl})`,
  ].join('\n')
}

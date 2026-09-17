/**
 * Tests for Linear message builder.
 */

import { describe, it, expect } from 'vitest'
import type { CommentCreatedEvent, PostCreatedEvent, EventData } from '@/lib/server/events/types'
import {
  buildLinearCommentBody,
  buildLinearIssueBody,
} from '@/integrations/linear/server/message'

function makePostCreatedEvent(overrides: Record<string, unknown> = {}): PostCreatedEvent {
  return {
    id: 'evt-1',
    type: 'post.created',
    timestamp: '2025-01-01T00:00:00Z',
    actor: { type: 'user', userId: 'user_1', email: 'test@test.com' },
    data: {
      post: {
        id: 'post_1',
        title: 'Feature request',
        content: '<p>Please add dark mode</p>',
        boardId: 'board_1',
        boardSlug: 'features',
        voteCount: 5,
        authorName: 'Jane Doe',
        authorEmail: 'jane@example.com',
        ...overrides,
      },
    },
  }
}

function makeCommentCreatedEvent(
  overrides: Record<string, unknown> = {}
): CommentCreatedEvent {
  return {
    id: 'evt-comment-1',
    type: 'comment.created',
    timestamp: '2025-01-01T00:00:00Z',
    actor: { type: 'user', userId: 'user_2', email: 'commenter@test.com' },
    data: {
      comment: {
        id: 'comment_1',
        content: 'I can reproduce this.',
        authorName: 'John Smith',
        authorEmail: 'john@example.com',
        isPrivate: false,
        ...overrides,
      },
      post: {
        id: 'post_1',
        title: 'Feature request',
        boardId: 'board_1',
        boardSlug: 'features',
      },
    },
  }
}

describe('buildLinearIssueBody', () => {
  it('builds title and description from post.created event', () => {
    const result = buildLinearIssueBody(makePostCreatedEvent(), 'https://feedback.example.com')

    expect(result.title).toBe('Feature request')
    expect(result.description).toContain('Please add dark mode')
    expect(result.description).toContain('**Submitted by:** Jane Doe')
    expect(result.description).toContain('**Board:** features')
    expect(result.description).toContain(
      '[View in Quackback](https://feedback.example.com/b/features/posts/post_1)'
    )
  })

  it('does not include vote count', () => {
    const result = buildLinearIssueBody(makePostCreatedEvent(), 'https://feedback.example.com')

    expect(result.description).not.toContain('Votes')
    expect(result.description).not.toContain('voteCount')
  })

  it('preserves headings, paragraphs, and bullet-list line breaks', () => {
    const result = buildLinearIssueBody(
      makePostCreatedEvent({
        content: [
          '## Vault',
          '',
          'The highest level where everything begins.',
          '',
          '- One vault can belong in multiple orgs.',
          '- One vault can have multiple spaces.',
          '',
          '## Hub',
          '',
          'A container that holds multiple spaces together.',
        ].join('\n'),
      }),
      'https://say.any.org'
    )

    expect(result.description).toContain(
      [
        '## Vault',
        '',
        'The highest level where everything begins.',
        '',
        '- One vault can belong in multiple orgs.',
        '- One vault can have multiple spaces.',
        '',
        '## Hub',
      ].join('\n')
    )
    expect(result.description).not.toContain('## Vault The highest')
  })

  it('keeps long feedback beyond the old 2,000-character preview limit', () => {
    const content = `${'Architecture paragraph. '.repeat(120)}\n\n## Final section\n\nKept in Linear.`
    const result = buildLinearIssueBody(makePostCreatedEvent({ content }), 'https://say.any.org')

    expect(content.length).toBeGreaterThan(2000)
    expect(result.description).toContain('## Final section\n\nKept in Linear.')
  })

  it('turns stored image paths into absolute URLs Linear can import', () => {
    const result = buildLinearIssueBody(
      makePostCreatedEvent({
        content: 'Before\n\n![Block menu](/api/storage/portal-media/block-menu.png)\n\nAfter',
      }),
      'https://say.any.org'
    )

    expect(result.description).toContain(
      '![Block menu](https://say.any.org/api/storage/portal-media/block-menu.png)'
    )
    expect(result.description).not.toContain('](/api/storage/')
  })

  it('embeds stored videos with absolute URLs so Linear copies them to private storage', () => {
    const result = buildLinearIssueBody(
      makePostCreatedEvent({
        content:
          'Reproduction\n\n[/api/storage/portal-media/recording.mov](/api/storage/portal-media/recording.mov)',
      }),
      'https://say.any.org/'
    )

    expect(result.description).toContain(
      '![Video: recording.mov](https://say.any.org/api/storage/portal-media/recording.mov)'
    )
    expect(result.description).not.toContain('](/api/storage/')
  })

  it('keeps every media item even when the narrative is truncated', () => {
    const result = buildLinearIssueBody(
      makePostCreatedEvent({
        content: `${'Long report '.repeat(900)}\n\n![Late screenshot](/api/storage/portal-media/late.png)`,
      }),
      'https://say.any.org'
    )

    expect(result.description).toContain(
      '![Late screenshot](https://say.any.org/api/storage/portal-media/late.png)'
    )
  })

  it('recovers media from legacy HTML content', () => {
    const result = buildLinearIssueBody(
      makePostCreatedEvent({
        content:
          '<p>Steps</p><img src="/api/storage/portal-media/shot.webp" alt="Shot"><video src="/api/storage/portal-media/demo.mp4" title="Demo"></video>',
      }),
      'https://say.any.org'
    )

    expect(result.description).toContain(
      '![Shot](https://say.any.org/api/storage/portal-media/shot.webp)'
    )
    expect(result.description).toContain(
      '![Video: Demo](https://say.any.org/api/storage/portal-media/demo.mp4)'
    )
  })

  it('converts legacy HTML headings and lists to Markdown', () => {
    const result = buildLinearIssueBody(
      makePostCreatedEvent({
        content:
          '<h2>Vault</h2><p>The highest level.</p><ul><li>One org</li><li>Many spaces</li></ul>',
      }),
      'https://say.any.org'
    )

    expect(result.description).toContain('## Vault\n\nThe highest level.\n\n-   One org\n-   Many spaces')
  })

  it('falls back to email when authorName is missing', () => {
    const result = buildLinearIssueBody(
      makePostCreatedEvent({ authorName: undefined }),
      'https://feedback.example.com'
    )

    expect(result.description).toContain('**Submitted by:** jane@example.com')
  })

  it('falls back to Anonymous when no author info', () => {
    const result = buildLinearIssueBody(
      makePostCreatedEvent({ authorName: undefined, authorEmail: undefined }),
      'https://feedback.example.com'
    )

    expect(result.description).toContain('**Submitted by:** Anonymous')
  })

  it('returns fallback for non post.created events', () => {
    const event = { type: 'post.status_changed' } as unknown as EventData
    const result = buildLinearIssueBody(event, 'https://example.com')

    expect(result.title).toBe('Feedback')
    expect(result.description).toBe('')
  })
})

describe('buildLinearCommentBody', () => {
  it('attributes the comment and links to its Quackback anchor', () => {
    const result = buildLinearCommentBody(
      makeCommentCreatedEvent(),
      'https://feedback.example.com'
    )

    expect(result).toContain('**John Smith commented:**')
    expect(result).toContain('I can reproduce this.')
    expect(result).toContain(
      '[View comment in Quackback](https://feedback.example.com/b/features/posts/post_1#comment-comment_1)'
    )
  })

  it('syncs comment images and videos with absolute URLs', () => {
    const result = buildLinearCommentBody(
      makeCommentCreatedEvent({
        content:
          'Evidence\n\n![Screenshot](/api/storage/portal-media/shot.png)\n\n[Recording](/api/storage/portal-media/demo.mov)',
      }),
      'https://say.any.org'
    )

    expect(result).toContain(
      '![Screenshot](https://say.any.org/api/storage/portal-media/shot.png)'
    )
    expect(result).toContain(
      '![Video: Recording](https://say.any.org/api/storage/portal-media/demo.mov)'
    )
  })

  it('falls back to the comment author email', () => {
    const result = buildLinearCommentBody(
      makeCommentCreatedEvent({ authorName: undefined }),
      'https://feedback.example.com'
    )

    expect(result).toContain('**john@example.com commented:**')
  })
})

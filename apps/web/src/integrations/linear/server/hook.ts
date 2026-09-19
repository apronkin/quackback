/**
 * Linear hook handler.
 * Creates Linear issues and forwards public feedback comments.
 */

import type { HookHandler, HookResult, HookRunContext } from '@/lib/server/events/hook-types'
import type { CommentCreatedEvent, EventData, PostUpdatedEvent } from '@/lib/server/events/types'
import type { IntegrationId, PostId } from '@quackback/ids'
import { isRetryableError } from '@/lib/server/events/hook-utils'
import { buildLinearCommentBody, buildLinearIssueBody } from '@/integrations/linear/server/message'
import { linearIssues } from '@/integrations/linear/server/issues'
import { createLinearComment, findLinkedLinearIssueId } from '@/integrations/linear/server/comments'
import { refreshLinkedLinearPost } from '@/integrations/linear/server/post-sync'
import {
  claimHookDelivery,
  completeHookDelivery,
  failHookDelivery,
  releaseHookDelivery,
} from '@/lib/server/events/hook-idempotency'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'linear' })

export interface LinearTarget {
  channelId: string // teamId is stored as channelId for consistency
}

export interface LinearConfig {
  accessToken: string
  rootUrl: string
  integrationId?: string
}

function linearFailure(error: unknown): HookResult {
  const errorMsg = error instanceof Error ? error.message : 'Unknown error'
  const status =
    error && typeof error === 'object' && 'status' in error
      ? Number((error as { status: unknown }).status)
      : undefined

  if (status === 401) {
    return {
      success: false,
      error: 'Authentication failed. Please reconnect Linear.',
      shouldRetry: false,
      authExpired: true,
    }
  }

  const retryable = (error as { retryable?: boolean }).retryable
  return {
    success: false,
    error: errorMsg,
    shouldRetry: retryable ?? isRetryableError(error),
  }
}

async function syncComment(
  event: CommentCreatedEvent,
  config: LinearConfig,
  ctx?: HookRunContext
): Promise<HookResult> {
  if (event.data.comment.isPrivate || !config.integrationId) return { success: true }

  let issueId: string | undefined
  try {
    issueId = await findLinkedLinearIssueId(event.data.post.id, config.integrationId)
  } catch (error) {
    return linearFailure(error)
  }
  if (!issueId) {
    log.debug({ post_id: event.data.post.id }, 'no linked issue for comment, skipping')
    return { success: true }
  }

  const claimed = await claimHookDelivery(ctx?.jobId, 'linear_comment')
  if (!claimed) {
    log.debug({ job_id: ctx?.jobId, issue_id: issueId }, 'skipping duplicate comment')
    return { success: true }
  }

  try {
    const commentId = await createLinearComment(
      config.accessToken,
      issueId,
      buildLinearCommentBody(event, config.rootUrl)
    )
    await completeHookDelivery(ctx?.jobId)
    log.info({ issue_id: issueId, comment_id: commentId }, 'comment created')
    return { success: true }
  } catch (error) {
    const result = linearFailure(error)
    if (result.shouldRetry || result.authExpired) await releaseHookDelivery(ctx?.jobId)
    else await failHookDelivery(ctx?.jobId)
    return result
  }
}

async function syncPostUpdate(event: PostUpdatedEvent, config: LinearConfig): Promise<HookResult> {
  if (!config.integrationId) return { success: true }
  if (!event.data.changedFields.some((field) => field === 'title' || field === 'content')) {
    return { success: true }
  }

  try {
    const updated = await refreshLinkedLinearPost(
      event.data.post.id as PostId,
      config.integrationId as IntegrationId
    )
    if (!updated) {
      return {
        success: false,
        error: 'Linked Linear issue is not ready yet.',
        shouldRetry: true,
      }
    }
    log.info({ post_id: event.data.post.id }, 'linked issue refreshed after post edit')
    return { success: true }
  } catch (error) {
    return linearFailure(error)
  }
}

export const linearHook: HookHandler = {
  async run(
    event: EventData,
    target: unknown,
    config: unknown,
    ctx?: HookRunContext
  ): Promise<HookResult> {
    const { channelId: teamId } = target as LinearTarget
    const linearConfig = config as LinearConfig
    const { accessToken, rootUrl } = linearConfig

    if (event.type === 'comment.created') {
      return syncComment(event, linearConfig, ctx)
    }

    if (event.type === 'post.updated') {
      return syncPostUpdate(event, linearConfig)
    }

    // Only create issues for new feedback. Edits are handled above and update
    // the existing link in place.
    if (event.type !== 'post.created') {
      return { success: true }
    }

    log.debug({ event_type: event.type, team_id: teamId }, 'creating issue')

    const { title, description } = buildLinearIssueBody(event, rootUrl)

    try {
      // The capability owns the GraphQL call + error classification; this
      // hook maps its thrown errors back onto the HookResult retry contract.
      const created = await linearIssues.create!({
        auth: { channelId: teamId, accessToken },
        title,
        bodyMarkdown: description,
      })

      log.info(
        {
          issue_id: created.externalId,
          issue_identifier: created.externalDisplayId,
          team_id: teamId,
        },
        'issue created'
      )
      return {
        success: true,
        externalId: created.externalId,
        externalDisplayId: created.externalDisplayId ?? undefined,
        externalUrl: created.externalUrl ?? undefined,
      }
    } catch (error) {
      return linearFailure(error)
    }
  },
}

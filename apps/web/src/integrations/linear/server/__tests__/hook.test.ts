/**
 * Tests for Linear hook handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CommentCreatedEvent, PostCreatedEvent, EventData } from '@/lib/server/events/types'
import { linearHook } from '@/integrations/linear/server/hook'
import { updateLinearIssue } from '@/integrations/linear/server/issues'

const mocks = vi.hoisted(() => ({
  findLinkedLinearIssueId: vi.fn(),
  claimHookDelivery: vi.fn(),
  completeHookDelivery: vi.fn(),
  failHookDelivery: vi.fn(),
  releaseHookDelivery: vi.fn(),
}))

vi.mock('@/integrations/linear/server/comments', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/integrations/linear/server/comments')
  >()
  return { ...actual, findLinkedLinearIssueId: mocks.findLinkedLinearIssueId }
})

vi.mock('@/lib/server/events/hook-idempotency', () => ({
  claimHookDelivery: mocks.claimHookDelivery,
  completeHookDelivery: mocks.completeHookDelivery,
  failHookDelivery: mocks.failHookDelivery,
  releaseHookDelivery: mocks.releaseHookDelivery,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown = {}) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
}

function makePostCreatedEvent(overrides: Record<string, unknown> = {}): PostCreatedEvent {
  return {
    id: 'evt-1',
    type: 'post.created',
    timestamp: '2025-01-01T00:00:00Z',
    actor: { type: 'user', userId: 'user_1', email: 'test@test.com' },
    data: {
      post: {
        id: 'post_1',
        title: 'Bug report',
        content: '<p>Something broke</p>',
        boardId: 'board_1',
        boardSlug: 'bugs',
        voteCount: 3,
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
        content: 'Here is a recording: [Demo](/api/storage/portal-media/demo.mov)',
        authorName: 'John Smith',
        isPrivate: false,
        ...overrides,
      },
      post: {
        id: 'post_1',
        title: 'Bug report',
        boardId: 'board_1',
        boardSlug: 'bugs',
      },
    },
  }
}

const target = { channelId: 'team-abc' }
const config = {
  accessToken: 'lin_test_token',
  rootUrl: 'https://app.example.com',
  integrationId: 'integration_1',
}

beforeEach(() => {
  vi.restoreAllMocks()
  mocks.findLinkedLinearIssueId.mockReset()
  mocks.findLinkedLinearIssueId.mockResolvedValue(undefined)
  mocks.claimHookDelivery.mockReset()
  mocks.claimHookDelivery.mockResolvedValue(true)
  mocks.completeHookDelivery.mockReset()
  mocks.completeHookDelivery.mockResolvedValue(undefined)
  mocks.failHookDelivery.mockReset()
  mocks.failHookDelivery.mockResolvedValue(undefined)
  mocks.releaseHookDelivery.mockReset()
  mocks.releaseHookDelivery.mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('linearHook', () => {
  it('skips unsupported events', async () => {
    const event = { type: 'post.status_changed' } as unknown as EventData
    const result = await linearHook.run(event, target, config)
    expect(result).toEqual({ success: true })
  })

  it('returns externalId (UUID) and externalDisplayId (identifier) on success', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: 'uuid-abc-123',
              identifier: 'QUA-42',
              url: 'https://linear.app/quackback/issue/QUA-42/bug-report',
            },
          },
        },
      })
    )

    const result = await linearHook.run(makePostCreatedEvent(), target, config)

    expect(result.success).toBe(true)
    expect(result.externalId).toBe('uuid-abc-123')
    expect(result.externalDisplayId).toBe('QUA-42')
    expect(result.externalUrl).toBe('https://linear.app/quackback/issue/QUA-42/bug-report')
  })

  it('sends correct GraphQL mutation with team ID', async () => {
    const fetchMock = mockFetch(200, {
      data: {
        issueCreate: {
          success: true,
          issue: { id: 'id', identifier: 'QUA-1', url: 'https://linear.app/issue' },
        },
      },
    })
    vi.stubGlobal('fetch', fetchMock)

    await linearHook.run(makePostCreatedEvent(), target, config)

    const call = fetchMock.mock.calls[0]
    expect(call[0]).toBe('https://api.linear.app/graphql')
    const body = JSON.parse(call[1].body)
    expect(body.variables.input.teamId).toBe('team-abc')
    expect(body.variables.input.title).toBe('Bug report')
    expect(body.query).toContain('issueCreate')
    expect(body.query).toContain('identifier')
  })

  it('returns failure on GraphQL errors', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { errors: [{ message: 'Team not found' }] }))

    const result = await linearHook.run(makePostCreatedEvent(), target, config)

    expect(result.success).toBe(false)
    expect(result.error).toBe('Team not found')
    expect(result.shouldRetry).toBe(false)
  })

  it('returns failure when no issue is returned', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, { data: { issueCreate: { success: true, issue: null } } })
    )

    const result = await linearHook.run(makePostCreatedEvent(), target, config)

    expect(result.success).toBe(false)
    expect(result.error).toBe('No issue returned')
  })

  it('returns non-retryable failure on 401', async () => {
    vi.stubGlobal('fetch', mockFetch(401))

    const result = await linearHook.run(makePostCreatedEvent(), target, config)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Authentication failed')
    expect(result.shouldRetry).toBe(false)
    expect(result.authExpired).toBe(true)
  })

  it('returns retryable failure on 429', async () => {
    vi.stubGlobal('fetch', mockFetch(429))

    const result = await linearHook.run(makePostCreatedEvent(), target, config)

    expect(result.success).toBe(false)
    expect(result.error).toBe('Rate limited')
    expect(result.shouldRetry).toBe(true)
  })

  it('adds a public comment to the already-linked Linear issue', async () => {
    mocks.findLinkedLinearIssueId.mockResolvedValue('issue-uuid-1')
    const fetchMock = mockFetch(200, {
      data: { commentCreate: { success: true, comment: { id: 'linear-comment-1' } } },
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await linearHook.run(makeCommentCreatedEvent(), target, config, {
      jobId: 'job-comment-1',
    })

    expect(result).toEqual({ success: true })
    expect(mocks.findLinkedLinearIssueId).toHaveBeenCalledWith('post_1', 'integration_1')
    expect(mocks.claimHookDelivery).toHaveBeenCalledWith('job-comment-1', 'linear_comment')
    expect(mocks.completeHookDelivery).toHaveBeenCalledWith('job-comment-1')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.query).toContain('commentCreate')
    expect(body.variables.input.issueId).toBe('issue-uuid-1')
    expect(body.variables.input.body).toContain('**John Smith commented:**')
    expect(body.variables.input.body).toContain(
      '![Video: Demo](https://app.example.com/api/storage/portal-media/demo.mov)'
    )
  })

  it('skips comments when the feedback has no linked Linear issue', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await linearHook.run(makeCommentCreatedEvent(), target, config, {
      jobId: 'job-comment-2',
    })

    expect(result).toEqual({ success: true })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.claimHookDelivery).not.toHaveBeenCalled()
  })

  it('defensively skips private comments', async () => {
    const result = await linearHook.run(
      makeCommentCreatedEvent({ isPrivate: true }),
      target,
      config,
      { jobId: 'job-comment-3' }
    )

    expect(result).toEqual({ success: true })
    expect(mocks.findLinkedLinearIssueId).not.toHaveBeenCalled()
  })

  it('deduplicates a retried comment job', async () => {
    mocks.findLinkedLinearIssueId.mockResolvedValue('issue-uuid-1')
    mocks.claimHookDelivery.mockResolvedValue(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await linearHook.run(makeCommentCreatedEvent(), target, config, {
      jobId: 'job-comment-4',
    })

    expect(result).toEqual({ success: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('releases the delivery claim when Linear asks for a retry', async () => {
    mocks.findLinkedLinearIssueId.mockResolvedValue('issue-uuid-1')
    vi.stubGlobal('fetch', mockFetch(429))

    const result = await linearHook.run(makeCommentCreatedEvent(), target, config, {
      jobId: 'job-comment-5',
    })

    expect(result.success).toBe(false)
    expect(result.shouldRetry).toBe(true)
    expect(mocks.releaseHookDelivery).toHaveBeenCalledWith('job-comment-5')
    expect(mocks.failHookDelivery).not.toHaveBeenCalled()
  })
})

describe('updateLinearIssue', () => {
  it('refreshes an existing issue without creating a duplicate', async () => {
    const fetchMock = mockFetch(200, {
      data: { issueUpdate: { success: true, issue: { id: 'uuid-abc-123' } } },
    })
    vi.stubGlobal('fetch', fetchMock)

    await updateLinearIssue('lin_test_token', 'uuid-abc-123', {
      title: 'Updated report',
      description: '![Screenshot](https://say.any.org/api/storage/portal-media/shot.png)',
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.query).toContain('issueUpdate')
    expect(body.query).not.toContain('issueCreate')
    expect(body.variables).toEqual({
      id: 'uuid-abc-123',
      input: {
        title: 'Updated report',
        description: '![Screenshot](https://say.any.org/api/storage/portal-media/shot.png)',
      },
    })
  })

  it('fails loudly when Linear rejects the refresh', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { errors: [{ message: 'Issue not found' }] }))

    await expect(
      updateLinearIssue('lin_test_token', 'missing', {
        title: 'Report',
        description: 'Body',
      })
    ).rejects.toThrow('Issue not found')
  })
})

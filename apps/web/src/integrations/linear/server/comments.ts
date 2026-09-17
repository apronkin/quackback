/** Linear comment creation and linked-issue lookup. */

import type { IntegrationId, PostId } from '@quackback/ids'
import { and, db, eq, postExternalLinks } from '@/lib/server/db'
import { issueError } from '@/lib/server/integrations/message-utils'
import { linearGraphql } from './issues'

const CREATE_COMMENT_MUTATION = `
  mutation CreateComment($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment {
        id
      }
    }
  }
`

/** Find the active Linear issue created by this integration for a post. */
export async function findLinkedLinearIssueId(
  postId: string,
  integrationId: string
): Promise<string | undefined> {
  const link = await db.query.postExternalLinks.findFirst({
    where: and(
      eq(postExternalLinks.postId, postId as PostId),
      eq(postExternalLinks.integrationId, integrationId as IntegrationId),
      eq(postExternalLinks.integrationType, 'linear'),
      eq(postExternalLinks.status, 'active')
    ),
    columns: { externalId: true },
  })

  return link?.externalId
}

/** Add a Markdown comment to an existing Linear issue. */
export async function createLinearComment(
  accessToken: string,
  issueId: string,
  body: string
): Promise<string> {
  const result = await linearGraphql(accessToken, CREATE_COMMENT_MUTATION, {
    input: { issueId, body },
  })

  if (result.errors?.length) {
    throw issueError(result.errors[0].message, { retryable: false })
  }
  const created = result.data?.commentCreate as
    | { success?: boolean; comment?: { id: string } }
    | undefined
  if (!created?.success || !created.comment) {
    throw issueError('Linear did not create the comment', { retryable: false })
  }

  return created.comment.id
}

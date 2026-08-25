import * as core from '@actions/core'
import * as github from '@actions/github'
import { isOurComment } from '../report/comment.js'

/**
 * Post or update the sticky comment.
 *
 * Never fatal. On a pull request from a fork the token is read-only and this
 * 403s; that is a permissions fact about forks, not a problem with the code
 * under review, so it degrades to a notice and the annotations and job summary
 * carry the result. Switching to `pull_request_target` to get a writable token
 * would run untrusted code with secrets, which is not a trade worth making.
 */
export async function postComment(body: string, token: string): Promise<void> {
  const context = github.context
  const issueNumber = context.payload.pull_request?.number
  if (!issueNumber) {
    core.info(`no pull request associated with the "${context.eventName}" event; skipping comment`)
    return
  }

  if (!token) {
    core.info('no github-token supplied; skipping comment')
    return
  }

  try {
    const octokit = github.getOctokit(token)
    const { owner, repo } = context.repo

    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    })

    const ours = comments.filter((comment) => isOurComment(comment.body))
    // Prefer one the bot wrote, so a human quoting the marker cannot hijack it.
    const existing = ours.find((comment) => comment.user?.type === 'Bot') ?? ours[0]

    if (existing) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body })
      core.debug(`updated comment ${existing.id}`)
    } else {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body })
      core.debug('created a new comment')
    }
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 403 || status === 404) {
      core.info(
        'Cannot comment on this pull request (the token is read-only, which is normal for ' +
          'forks). Results are in the annotations and the job summary.',
      )
      return
    }
    core.warning(`Could not post the comment: ${(error as Error).message}`)
  }
}

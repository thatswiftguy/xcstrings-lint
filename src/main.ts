import * as core from '@actions/core'
import * as github from '@actions/github'
import { ConfigError, DEFAULT_CONFIG_PATH } from './core/config.js'
import { BaseRefError, type Mode } from './core/ratchet.js'
import { CatalogParseError } from './core/types.js'
import { planAnnotations } from './report/annotations.js'
import { COMMENT_MARKER, isOurComment, renderComment, truncate } from './report/comment.js'
import { renderParseErrors, renderSummary } from './report/summary.js'
import { run, type RunResult } from './run.js'

/** Action outputs have a size limit; the full report lives in the job summary. */
const MAX_REPORT_OUTPUT = 50_000

async function runAction(): Promise<void> {
  const mode = readMode()
  const shouldComment = readBoolean('comment', true)
  const shouldAnnotate = readBoolean('annotations', true)
  const shouldFail = readBoolean('fail', true)
  const configPath = core.getInput('config') || DEFAULT_CONFIG_PATH

  const result: RunResult = run({
    cwd: process.cwd(),
    configPath,
    // The default path is allowed to be absent -- zero-config is supported.
    configExplicit: configPath !== DEFAULT_CONFIG_PATH,
    mode,
    threshold: readThreshold(),
    baseRef: mode === 'ratchet' ? requireBaseRef() : undefined,
    allowFetch: true,
    onNotice: (message) => core.info(message),
  })

  if (result.parseErrors.length > 0) {
    for (const parseError of result.parseErrors) {
      core.error(parseError.message, {
        title: 'Unreadable catalog',
        file: parseError.file,
        ...(parseError.line === undefined ? {} : { startLine: parseError.line }),
      })
    }
    await writeSummary(renderParseErrors(result.parseErrors))
    return misconfigured(
      `Could not read ${result.parseErrors.length} catalog file(s). See the annotations above.`,
    )
  }

  const { input } = result

  const plan = planAnnotations(input.blocking)
  if (shouldAnnotate) {
    for (const annotation of plan.annotations) {
      const properties = {
        title: annotation.title,
        file: annotation.file,
        startLine: annotation.line,
        ...(annotation.column === undefined ? {} : { startColumn: annotation.column }),
      }
      if (annotation.level === 'error') core.error(annotation.message, properties)
      else core.warning(annotation.message, properties)
    }
    if (plan.totalDropped > 0) {
      core.info(`+ ${plan.totalDropped} more — see the job summary`)
    }
  }
  if (plan.totalDropped > 0) input.annotationsDropped = plan.totalDropped

  const body = renderComment(input)
  await writeSummary(renderSummary(input))
  if (shouldComment) await postComment(body)

  core.setOutput('passed', String(input.passed))
  core.setOutput(
    'coverage',
    JSON.stringify(
      Object.fromEntries(
        Object.entries(input.result.coverage).map(([language, c]) => [language, c.percent]),
      ),
    ),
  )
  core.setOutput('issue-count', String(input.blocking.filter((i) => i.severity === 'error').length))
  core.setOutput('report', truncate(body, MAX_REPORT_OUTPUT))

  if (input.passed) {
    core.info('No new localization issues.')
    return
  }
  if (shouldFail) core.setFailed(failureSummary(input.blocking.length, mode))
  else core.warning(`${failureSummary(input.blocking.length, mode)} (fail: false, not blocking)`)
}

function failureSummary(count: number, mode: Mode): string {
  const noun = count === 1 ? 'issue' : 'issues'
  return mode === 'ratchet'
    ? `${count} new localization ${noun} introduced by this change.`
    : `${count} localization ${noun} found.`
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

function readMode(): Mode {
  const value = (core.getInput('mode') || 'ratchet').trim()
  if (value !== 'ratchet' && value !== 'absolute') {
    throw new ConfigError(`mode must be "ratchet" or "absolute", got "${value}"`)
  }
  return value
}

/**
 * Read a boolean input, falling back rather than throwing when it is absent.
 *
 * `core.getBooleanInput` throws on an empty value. Action defaults mean that
 * normally cannot happen, but a hard crash on a missing input is a poor trade
 * for a check whose whole job is to produce a readable failure.
 */
function readBoolean(name: string, fallback: boolean): boolean {
  const raw = core.getInput(name).trim()
  if (raw === '') return fallback
  if (['true', 'True', 'TRUE'].includes(raw)) return true
  if (['false', 'False', 'FALSE'].includes(raw)) return false
  throw new ConfigError(`${name} must be true or false, got "${raw}"`)
}

function readThreshold(): number {
  const raw = core.getInput('threshold') || '100'
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new ConfigError(`threshold must be a number between 0 and 100, got "${raw}"`)
  }
  return value
}

/**
 * Work out what to ratchet against.
 *
 * Pull requests give a base branch. Pushes do not, but `payload.before` is the
 * commit the branch was at, which is the right comparison for a push -- so
 * `on: push` works without anyone having to switch modes.
 */
function requireBaseRef(): string {
  const context = github.context
  const fromPullRequest = context.payload.pull_request?.base?.ref
  if (typeof fromPullRequest === 'string' && fromPullRequest) return fromPullRequest

  if (process.env.GITHUB_BASE_REF) return process.env.GITHUB_BASE_REF

  const before = context.payload.before
  // All-zeros means the branch did not exist before this push.
  if (typeof before === 'string' && before && !/^0+$/.test(before)) return before

  throw new BaseRefError(
    `Ratchet mode needs a base to compare against, and the "${context.eventName}" event does not provide one.\n\n` +
      'Either run this on `pull_request`, or set `mode: absolute` for other events:\n\n' +
      '    - uses: thatswiftguy/xcstrings-lint@v1\n' +
      '      with:\n' +
      '        mode: absolute',
  )
}

/* -------------------------------------------------------------------------- */
/* Output surfaces                                                             */
/* -------------------------------------------------------------------------- */

async function writeSummary(markdown: string): Promise<void> {
  try {
    await core.summary.addRaw(markdown).write()
  } catch (error) {
    // No $GITHUB_STEP_SUMMARY (a local act run, say). The log still gets it.
    core.info(markdown)
    core.debug(`could not write the job summary: ${(error as Error).message}`)
  }
}

/**
 * Post or update the sticky comment.
 *
 * Never fatal. On a pull request from a fork the token is read-only and this
 * 403s; that is a permissions fact about forks, not a problem with the code
 * under review, so it degrades to a notice and the annotations and job summary
 * carry the result. Switching to `pull_request_target` to get a writable token
 * would run untrusted code with secrets, which is not a trade worth making.
 */
async function postComment(body: string): Promise<void> {
  const context = github.context
  const issueNumber = context.payload.pull_request?.number
  if (!issueNumber) {
    core.info(`no pull request associated with the "${context.eventName}" event; skipping comment`)
    return
  }

  const token = core.getInput('github-token')
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
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      })
      core.debug(`updated comment ${existing.id}`)
    } else {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      })
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

/** Exit 2: the tool is misconfigured, as distinct from failing translations. */
function misconfigured(message: string): void {
  core.setFailed(message)
  // setFailed sets 1; the spec reserves 2 for "this tool is misconfigured".
  process.exitCode = 2
}

/**
 * Every "you configured this wrong" path has to land on exit 2, including the
 * ones that fire while reading inputs, before the run even starts. Catching
 * them in one place is what keeps that promise honest.
 */
async function main(): Promise<void> {
  try {
    await runAction()
  } catch (error) {
    if (error instanceof ConfigError || error instanceof BaseRefError) {
      return misconfigured(error.message)
    }
    if (error instanceof CatalogParseError) {
      return misconfigured(`${error.file}: ${error.message}`)
    }
    core.setFailed(error instanceof Error ? error.stack || error.message : String(error))
  }
}

void main()

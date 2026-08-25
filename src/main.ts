import * as core from '@actions/core'
import * as github from '@actions/github'
import { postComment } from './action/comment.js'
import { detectBaseRef, readInputs, type ActionInputs } from './action/inputs.js'
import { ConfigError } from './core/config.js'
import { BaseRefError } from './core/revision.js'
import { CatalogParseError } from './core/types.js'
import { exitCodeFor, lint, type LintResult } from './lint.js'
import { planAnnotations } from './report/annotations.js'
import { renderComment, truncate } from './report/comment.js'
import { renderParseErrors, renderSummary } from './report/summary.js'

/** Action outputs have a size limit; the full report lives in the job summary. */
const MAX_REPORT_OUTPUT = 50_000

async function runAction(): Promise<void> {
  const inputs = readInputs((name) => core.getInput(name))

  const result: LintResult = lint({
    cwd: process.cwd(),
    configPath: inputs.configPath,
    configExplicit: inputs.configExplicit,
    mode: inputs.mode,
    threshold: inputs.threshold,
    baseRef: detectBaseRef({
      pullRequestBase: github.context.payload.pull_request?.base?.ref,
      environment: process.env.GITHUB_BASE_REF,
      pushBefore:
        typeof github.context.payload.before === 'string'
          ? github.context.payload.before
          : undefined,
    }),
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

  const report = result.report
  if (inputs.annotations) {
    const dropped = emitAnnotations([...report.blocking, ...report.warnings])
    if (dropped > 0) report.annotationsDropped = dropped
  }

  const body = renderComment(report)
  await writeSummary(renderSummary(report))
  if (inputs.comment) await postComment(body, core.getInput('github-token'))

  setOutputs(report, body)

  // exitCodeFor is the single definition of the 0/1/2 contract. Parse errors
  // (2) already returned above, so this is 0 or 1 -- and because the action
  // asks the same function the tests assert on, the two cannot drift.
  if (exitCodeFor(result) === 0) {
    core.info(`No localization issues across ${report.filesScanned} file(s).`)
    return
  }

  const summary = failureSummary(report.blocking.length, report.shortfalls.length, inputs)
  if (inputs.fail) core.setFailed(summary)
  else core.warning(`${summary} (fail: false, not blocking)`)
}

/** Emit inline annotations and return how many the per-level cap discarded. */
function emitAnnotations(issues: Parameters<typeof planAnnotations>[0]): number {
  const plan = planAnnotations(issues)
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
  if (plan.totalDropped > 0) core.info(`+ ${plan.totalDropped} more — see the job summary`)
  return plan.totalDropped
}

function setOutputs(report: LintResult['report'], body: string): void {
  core.setOutput('passed', String(report.passed))
  core.setOutput(
    'coverage',
    JSON.stringify(
      Object.fromEntries(
        Object.entries(report.result.coverage).map(([language, c]) => [language, c.percent]),
      ),
    ),
  )
  core.setOutput('issue-count', String(report.blocking.length))
  core.setOutput('warning-count', String(report.warnings.length))
  core.setOutput('pre-existing-count', String(report.preExisting.length))
  core.setOutput('files-scanned', String(report.filesScanned))
  core.setOutput('report', truncate(body, MAX_REPORT_OUTPUT))
}

function failureSummary(errors: number, shortfalls: number, inputs: ActionInputs): string {
  const parts: string[] = []
  if (errors > 0) {
    const noun = errors === 1 ? 'issue' : 'issues'
    parts.push(
      inputs.mode === 'ratchet'
        ? `${errors} new localization ${noun} introduced by this change`
        : `${errors} localization ${noun} found`,
    )
  }
  if (shortfalls > 0) {
    parts.push(
      `${shortfalls} ${shortfalls === 1 ? 'language is' : 'languages are'} below the ${inputs.threshold}% threshold`,
    )
  }
  return `${parts.join('; ')}.`
}

async function writeSummary(markdown: string): Promise<void> {
  try {
    await core.summary.addRaw(markdown).write()
  } catch (error) {
    // No $GITHUB_STEP_SUMMARY (a local act run, say). The log still gets it.
    core.info(markdown)
    core.debug(`could not write the job summary: ${(error as Error).message}`)
  }
}

/** Exit 2: the tool is misconfigured, as distinct from failing translations. */
function misconfigured(message: string): void {
  core.setFailed(message)
  // setFailed sets exit 1; 2 is reserved for "this tool is misconfigured".
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

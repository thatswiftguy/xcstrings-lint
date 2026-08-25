import { isAbsolute, join } from 'node:path'
import { analyze, type AnalysisResult } from './core/analyze.js'
import { compareIssues, unifiedLanguages, type Comparison } from './core/compare.js'
import { ConfigError, loadConfig, type ResolvedConfig } from './core/config.js'
import { belowThreshold, type ThresholdShortfall } from './core/coverage.js'
import { scan, scanWorkingTree } from './core/scan.js'
import {
  BaseRefError,
  gitRevisionFiles,
  resolveBaseRevision,
} from './core/revision.js'
import type { CatalogParseError, Issue } from './core/types.js'
import type { ReportInput } from './report/model.js'

/**
 * What decides pass or fail.
 *
 * Both modes read the whole repository and report everything they find. The
 * only difference is the gate: `full` blocks on every problem, `ratchet` blocks
 * only on the ones this change introduced and shows the rest as context.
 */
export type Mode = 'full' | 'ratchet'

export interface LintOptions {
  cwd: string
  /** Config file path. Relative paths resolve against `cwd`, not the process. */
  configPath: string
  /** True when the user named the config path, making "not found" fatal. */
  configExplicit?: boolean
  mode?: Mode
  /** Minimum coverage percent per language. Not applied in ratchet mode. */
  threshold?: number
  /** Base branch to compare against, e.g. `main`. */
  baseRef?: string | undefined
  /** Allow a git fetch when the base ref is missing. On in CI, off locally. */
  allowFetch?: boolean
  onNotice?: ((message: string) => void) | undefined
  /** Injected for tests; defaults to loading from disk. */
  config?: ResolvedConfig | undefined
}

export interface LintResult {
  report: ReportInput
  config: ResolvedConfig
  /**
   * Files that could not be read at all. Always fatal (exit 2): reporting 100%
   * coverage for a file we failed to parse would be worse than stopping.
   */
  parseErrors: CatalogParseError[]
}

/**
 * The whole check, in one call.
 *
 * Kept separate from `main.ts` so the engine can be exercised without the
 * GitHub Actions runtime: every test drives this directly, and nothing in here
 * touches `@actions/core`.
 */
export function lint(options: LintOptions): LintResult {
  // Resolved against `cwd` so that scanning one directory does not silently
  // pick up a config file belonging to another.
  const configPath = isAbsolute(options.configPath)
    ? options.configPath
    : join(options.cwd, options.configPath)
  const config = options.config ?? loadConfig(configPath, options.configExplicit ?? false)
  const mode = options.mode ?? 'full'
  const threshold = options.threshold ?? 100

  const head = scanWorkingTree(options.cwd, config)

  // Finding nothing is a configuration error, not a pass. A linter that reports
  // "every language is fully translated" because its globs match no files is
  // worse than one that is switched off, because it looks like it is working.
  if (head.matched.length === 0) {
    throw new ConfigError(
      `no catalog files matched. Searched for:\n` +
        config.paths.map((pattern) => `  - ${pattern}`).join('\n') +
        `\n\nCheck the "paths" option${config.source ? ` in ${config.source}` : ''}, or that the ` +
        'checkout ran before this step.',
    )
  }

  const baseline = resolveBaseline(options, config, mode)
  const languages = unifiedLanguages(head.catalogs, baseline?.scan.catalogs ?? [])
  const result = analyze(head.catalogs, config, { languages })

  const comparison = baseline
    ? compareIssues(result, analyze(baseline.scan.catalogs, config, { languages }), {
        baseLabel: baseline.label,
        baseErrors: baseline.scan.errors,
      })
    : undefined

  return {
    config,
    // A base we could not parse makes every head issue look new, so it is just
    // as fatal as one on our own side.
    parseErrors: [...head.errors, ...(comparison?.baseErrors ?? [])],
    report: buildReport(result, {
      config,
      mode,
      threshold,
      filesScanned: head.matched.length,
      ...(comparison ? { comparison } : {}),
    }),
  }
}

interface Baseline {
  label: string
  scan: ReturnType<typeof scan>
}

/**
 * Load the base revision, if there is one to load.
 *
 * In ratchet mode a missing base is fatal: without it there is nothing to
 * ratchet against and passing everything would be a lie. In full mode it is
 * only a notice -- the check still works, it just cannot say which problems are
 * new, so a local run or a `schedule` event degrades instead of failing.
 */
function resolveBaseline(
  options: LintOptions,
  config: ResolvedConfig,
  mode: Mode,
): Baseline | undefined {
  if (!options.baseRef) {
    if (mode === 'ratchet') {
      throw new BaseRefError(
        'Ratchet mode needs a base branch to compare against, and none was supplied.\n\n' +
          'Run this on `pull_request`, or use the default `mode: full`.',
      )
    }
    return undefined
  }

  const { revision, problem } = resolveBaseRevision({
    cwd: options.cwd,
    baseRef: options.baseRef,
    allowFetch: options.allowFetch ?? false,
    ...(options.onNotice ? { onNotice: options.onNotice } : {}),
  })

  if (!revision) {
    if (mode === 'ratchet') throw new BaseRefError(`Ratchet mode ${problem}`)
    options.onNotice?.(`${problem} -- reporting every issue without marking which are new`)
    return undefined
  }

  return { label: revision, scan: scan(gitRevisionFiles(revision, options.cwd), config) }
}

export interface BuildReportOptions {
  config: ResolvedConfig
  mode: Mode
  threshold: number
  filesScanned: number
  comparison?: Comparison
}

/**
 * Turn an analysis into the shape all three report surfaces read.
 *
 * The verdict lives here and nowhere else. `passed` is the one thing the whole
 * action exists to decide, and having exactly one function compute it means the
 * comment, the summary and the exit code cannot disagree about it.
 */
export function buildReport(result: AnalysisResult, options: BuildReportOptions): ReportInput {
  const { comparison, mode } = options

  // Ratchet mode does not apply the coverage threshold. Adding ten translated
  // strings and one untranslated one moves the percentage *up* while shipping
  // an untranslated string, so a percentage is the wrong gate for "what did
  // this change do" -- the set difference is the whole point.
  const shortfalls =
    mode === 'ratchet'
      ? []
      : belowThreshold(result.coverage, options.threshold, {
          required: options.config.required,
          sourceLanguages: result.sourceLanguages,
        })

  const gated = mode === 'ratchet' && comparison ? comparison.newIssues : result.issues
  const blocking = gated.filter((issue) => issue.severity === 'error')
  const blockingSet = new Set(blocking)
  const nonBlocking = result.issues.filter((issue) => !blockingSet.has(issue))

  const preExistingSet = new Set(comparison?.preExisting ?? [])

  return {
    mode,
    // Coverage at threshold is not the whole story: a format-specifier mismatch
    // crashes at runtime while coverage still reads 100%.
    passed: shortfalls.length === 0 && blocking.length === 0,
    result,
    issues: result.issues,
    blocking,
    // Split so the report never files a pre-existing problem under "warnings".
    warnings: nonBlocking.filter((issue) => !preExistingSet.has(issue)),
    // The honest set: everything the base branch had too, blocking or not. What
    // the report *shows* under "pre-existing" is the non-blocking part of it --
    // see `carriedIssues` -- but the count has to be the truth, because in full
    // mode every one of these blocks and reporting zero would be a lie.
    preExisting: comparison?.preExisting ?? [],
    newIssues: comparison?.newIssues ?? [],
    fixed: comparison?.fixed ?? [],
    ...(comparison ? { baseLabel: comparison.baseLabel } : {}),
    comparedToBase: comparison !== undefined,
    shortfalls,
    threshold: options.threshold,
    filesScanned: options.filesScanned,
  }
}

/** Process exit code for a completed run, before `fail: false` is applied. */
export function exitCodeFor(result: LintResult): 0 | 1 | 2 {
  if (result.parseErrors.length > 0) return 2
  return result.report.passed ? 0 : 1
}

export { BaseRefError }
export type { Issue, ThresholdShortfall }

import { isAbsolute, join } from 'node:path'
import { analyze, type AnalysisResult } from './core/analyze.js'
import { ConfigError, loadConfig, type ResolvedConfig } from './core/config.js'
import { belowThreshold, type ThresholdShortfall } from './core/coverage.js'
import { scan } from './core/scan.js'
import type { CatalogParseError, Issue } from './core/types.js'
import type { ReportInput } from './report/model.js'

export interface LintOptions {
  cwd: string
  /** Config file path. Relative paths resolve against `cwd`, not the process. */
  configPath: string
  /** True when the user named the config path, making "not found" fatal. */
  configExplicit?: boolean
  /** Minimum coverage percent per language. */
  threshold?: number
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
  const threshold = options.threshold ?? 100

  const scanned = scan(options.cwd, config)

  // Finding nothing is a configuration error, not a pass. A linter that reports
  // "every language is fully translated" because its globs match no files is
  // worse than one that is switched off, because it looks like it is working.
  if (scanned.matched.length === 0) {
    throw new ConfigError(
      `no catalog files matched. Searched for:\n` +
        config.paths.map((pattern) => `  - ${pattern}`).join('\n') +
        `\n\nCheck the "paths" option${config.source ? ` in ${config.source}` : ''}, or that the ` +
        'checkout ran before this step.',
    )
  }

  return {
    config,
    parseErrors: scanned.errors,
    report: buildReport(analyze(scanned.catalogs, config), {
      config,
      threshold,
      filesScanned: scanned.matched.length,
    }),
  }
}

export interface BuildReportOptions {
  config: ResolvedConfig
  threshold: number
  filesScanned: number
}

/**
 * Turn an analysis into the shape all three report surfaces read.
 *
 * The verdict lives here and nowhere else. `passed` is the one thing the whole
 * action exists to decide, and having exactly one function compute it means the
 * comment, the summary and the exit code cannot disagree about it.
 */
export function buildReport(result: AnalysisResult, options: BuildReportOptions): ReportInput {
  const shortfalls = belowThreshold(result.coverage, options.threshold, {
    required: options.config.required,
    sourceLanguages: result.sourceLanguages,
  })

  const errors = result.issues.filter((issue) => issue.severity === 'error')
  const warnings = result.issues.filter((issue) => issue.severity === 'warn')

  return {
    // Coverage at threshold is not the whole story: a format-specifier mismatch
    // crashes at runtime while coverage still reads 100%.
    passed: shortfalls.length === 0 && errors.length === 0,
    result,
    issues: result.issues,
    errors,
    warnings,
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

export type { Issue, ThresholdShortfall }

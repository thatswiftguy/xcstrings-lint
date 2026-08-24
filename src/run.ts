import { isAbsolute, join } from 'node:path'
import { analyze } from './core/analyze.js'
import { loadConfig, type ResolvedConfig } from './core/config.js'
import { loadCatalogs, workingTreeFiles } from './core/load.js'
import {
  baseRevisionFiles,
  belowThreshold,
  compareToBase,
  resolveBaseRevision,
  type Mode,
} from './core/ratchet.js'
import type { CatalogParseError, Issue } from './core/types.js'
import type { ReportInput } from './report/model.js'

export interface RunOptions {
  cwd: string
  /** Config file path. Relative paths resolve against `cwd`, not the process. */
  configPath: string
  /** True when the user named the config path, making "not found" fatal. */
  configExplicit?: boolean
  mode: Mode
  /** Minimum coverage per language in absolute mode. */
  threshold?: number
  /** Base branch to ratchet against, e.g. `main`. */
  baseRef?: string | undefined
  /** Allow a git fetch when the base ref is missing. On in CI, off locally. */
  allowFetch?: boolean
  onNotice?: ((message: string) => void) | undefined
  /** Injected for tests; defaults to loading from disk. */
  config?: ResolvedConfig | undefined
}

export interface RunResult {
  input: ReportInput
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
export function run(options: RunOptions): RunResult {
  // Resolved against `cwd` so that scanning one directory does not silently
  // pick up a config file belonging to another.
  const configPath = isAbsolute(options.configPath)
    ? options.configPath
    : join(options.cwd, options.configPath)
  const config = options.config ?? loadConfig(configPath, options.configExplicit ?? false)
  const threshold = options.threshold ?? 100

  const head = loadCatalogs(workingTreeFiles(options.cwd, config), config)
  const parseErrors = [...head.errors]

  if (options.mode === 'ratchet') {
    const revision = resolveBaseRevision({
      cwd: options.cwd,
      baseRef: options.baseRef ?? '',
      allowFetch: options.allowFetch ?? false,
      ...(options.onNotice ? { onNotice: options.onNotice } : {}),
    })

    const comparison = compareToBase(head.catalogs, baseRevisionFiles(revision, options.cwd), config)
    // A base we could not parse makes every head issue look new. Better to stop
    // than to fail a PR for a hundred problems it did not introduce.
    parseErrors.push(...comparison.baseErrors)

    const attributed = comparison.newIssues
    return {
      config,
      parseErrors,
      input: {
        mode: 'ratchet',
        passed: countErrors(attributed) === 0,
        result: comparison.head,
        allIssues: comparison.head.issues,
        blocking: attributed,
        comparison,
        ...(options.baseRef ? { baseRef: options.baseRef } : {}),
      },
    }
  }

  const result = analyze(head.catalogs, config)
  const shortfalls = belowThreshold(result.coverage, threshold, config.required)

  return {
    config,
    parseErrors,
    input: {
      mode: 'absolute',
      // Coverage at threshold is not the whole story: a format-specifier
      // mismatch crashes at runtime while coverage still reads 100%.
      passed: shortfalls.length === 0 && countErrors(result.issues) === 0,
      result,
      allIssues: result.issues,
      blocking: result.issues,
      shortfalls,
      threshold,
    },
  }
}

function countErrors(issues: Issue[]): number {
  return issues.filter((issue) => issue.severity === 'error').length
}

/** Process exit code for a completed run, before `fail: false` is applied. */
export function exitCodeFor(result: RunResult): 0 | 1 | 2 {
  if (result.parseErrors.length > 0) return 2
  return result.input.passed ? 0 : 1
}

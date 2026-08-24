import { execFileSync } from 'node:child_process'
import { analyze, type AnalysisResult } from './analyze.js'
import { gitRevisionFiles, loadCatalogs, type RevisionFiles } from './load.js'
import type { ResolvedConfig } from './config.js'
import type { Catalog, CatalogParseError, Issue, LanguageCoverage } from './types.js'

export type Mode = 'ratchet' | 'absolute'

/**
 * The base branch could not be resolved. Distinct from "translations are
 * incomplete": this is a setup problem and exits 2, not 1.
 */
export class BaseRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BaseRefError'
  }
}

/**
 * Identity of an issue for ratchet purposes.
 *
 * The five state classes share one identity per (catalog, key, language),
 * because they are mutually exclusive states of the same pair -- a translation
 * that goes from `new` to `empty` is still the same untranslated string and
 * must not register as a fresh regression. The structural checks each get their
 * own identity, because a format-specifier break in an already-`needs_review`
 * string is genuinely a new problem.
 */
export function issueIdentity(issue: Issue): string {
  const group =
    issue.class === 'formatSpecifier' || issue.class === 'pluralCoverage' ? issue.class : 'state'
  // JSON-encoded so no separator can collide with a path, key or language.
  return JSON.stringify([issue.catalog, issue.key, issue.language ?? null, group])
}

export interface RatchetComparison {
  /** Revision the head was compared against. */
  baseLabel: string
  /** Head analysed against the unified language set. Use this, not your own. */
  head: AnalysisResult
  /** Base analysed against the same language set. */
  base: AnalysisResult
  /** Issues present at head that were not present at base. These are the gate. */
  newIssues: Issue[]
  /** Issues present at base and gone at head. Shown as credit, never as a gate. */
  fixedIssues: Issue[]
  baseCoverage: Record<string, LanguageCoverage>
  /** Parse failures on the base side, which make the comparison untrustworthy. */
  baseErrors: CatalogParseError[]
}

/**
 * Compare head against base semantically.
 *
 * Never textually: Xcode rewrites large regions of `.xcstrings` JSON on every
 * build, so a text diff of these files is almost pure noise. Both sides are
 * parsed into issue sets and the sets are compared.
 */
export function compareToBase(
  headCatalogs: Catalog[],
  base: RevisionFiles,
  config: ResolvedConfig,
): RatchetComparison {
  const loaded = loadCatalogs(base, config)

  // Both sides are assessed against the union of the languages either side
  // knows about, so adding or removing a language cannot skew the comparison.
  const languages = new Set<string>()
  for (const catalog of [...headCatalogs, ...loaded.catalogs]) {
    for (const language of catalog.languages) languages.add(language)
  }
  const options = { languages: [...languages].sort() }

  const headResult = analyze(headCatalogs, config, options)
  const baseResult = analyze(loaded.catalogs, config, options)

  const baseIdentities = new Set(baseResult.issues.map(issueIdentity))
  const headIdentities = new Set(headResult.issues.map(issueIdentity))

  return {
    baseLabel: base.label,
    head: headResult,
    base: baseResult,
    newIssues: headResult.issues.filter((issue) => !baseIdentities.has(issueIdentity(issue))),
    fixedIssues: baseResult.issues.filter((issue) => !headIdentities.has(issueIdentity(issue))),
    baseCoverage: baseResult.coverage,
    baseErrors: loaded.errors,
  }
}

/* -------------------------------------------------------------------------- */
/* Resolving the base revision                                                 */
/* -------------------------------------------------------------------------- */

const FETCH_DEPTH_HINT = [
  'The ratchet compares against the base branch, which is not in this clone.',
  'Add fetch-depth: 0 to your checkout step:',
  '',
  '    - uses: actions/checkout@v5',
  '      with:',
  '        fetch-depth: 0',
  '',
  'Or switch to mode: absolute, which needs no base branch.',
].join('\n')

function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

export interface BaseRevisionOptions {
  cwd: string
  /** Branch name, e.g. `main` -- typically GITHUB_BASE_REF. */
  baseRef: string
  /** Attempt a fetch when the ref is missing. Off for local CLI runs. */
  allowFetch?: boolean
  onNotice?: (message: string) => void
}

/**
 * Resolve the revision to compare against.
 *
 * Prefers the merge base over the base tip: comparing against the tip
 * attributes everything that landed on main since the branch point to this PR,
 * in both directions, which is exactly the unfair complaint the ratchet exists
 * to avoid.
 */
export function resolveBaseRevision(options: BaseRevisionOptions): string {
  const { cwd, baseRef, allowFetch = false, onNotice } = options
  if (!baseRef) {
    throw new BaseRefError(`No base branch to compare against.\n\n${FETCH_DEPTH_HINT}`)
  }

  const candidates = [`origin/${baseRef}`, baseRef, `refs/remotes/origin/${baseRef}`]
  const verify = (ref: string): boolean =>
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd) !== undefined

  let resolved = candidates.find(verify)

  if (!resolved && allowFetch) {
    onNotice?.(`base ref "${baseRef}" is not in this clone; fetching it`)
    git(
      [
        'fetch',
        '--no-tags',
        '--quiet',
        'origin',
        `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`,
      ],
      cwd,
    )
    resolved = candidates.find(verify)
  }

  if (!resolved) {
    throw new BaseRefError(`Could not resolve the base branch "${baseRef}".\n\n${FETCH_DEPTH_HINT}`)
  }

  const mergeBase = git(['merge-base', resolved, 'HEAD'], cwd)
  if (mergeBase) return mergeBase

  // Shallow clones often have the branch tip but not enough history to find a
  // merge base. Comparing against the tip is still far better than nothing.
  onNotice?.(
    `no merge base between ${resolved} and HEAD (likely a shallow clone); ` +
      `comparing against ${resolved} directly. Set fetch-depth: 0 for an exact comparison.`,
  )
  return resolved
}

export function baseRevisionFiles(revision: string, cwd: string): RevisionFiles {
  return gitRevisionFiles(revision, cwd)
}

/* -------------------------------------------------------------------------- */
/* Absolute mode                                                               */
/* -------------------------------------------------------------------------- */

export interface ThresholdShortfall {
  language: string
  percent: number
  threshold: number
}

/** Languages below the threshold, for `mode: absolute`. */
export function belowThreshold(
  coverage: Record<string, LanguageCoverage>,
  threshold: number,
  required?: string[],
): ThresholdShortfall[] {
  const languages = required ?? Object.keys(coverage)
  return languages
    .map((language) => ({
      language,
      percent: coverage[language]?.percent ?? 0,
      threshold,
    }))
    .filter((entry) => entry.percent < threshold)
    .sort((a, b) => a.percent - b.percent || a.language.localeCompare(b.language))
}

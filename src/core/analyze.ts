import { assessCatalog, type CatalogAssessment } from './assess.js'
import { createIgnoreMatchers, type ResolvedConfig } from './config.js'
import { computeCoverage } from './coverage.js'
import { ALL_RULES, type PendingIssue, type Rule } from './rules/index.js'
import type { Catalog, Issue, LanguageCode, LanguageCoverage } from './types.js'

export interface AnalysisResult {
  catalogs: Catalog[]
  issues: Issue[]
  /** Keyed by language. Source languages are excluded. */
  coverage: Record<LanguageCode, LanguageCoverage>
  /** Target languages actually assessed, sorted. */
  languages: LanguageCode[]
  /** Every language that is the source of at least one catalog, sorted. */
  sourceLanguages: LanguageCode[]
}

export interface AnalyzeOptions {
  /** Run a subset of the checks. Defaults to all of them; injected by tests. */
  rules?: readonly Rule[]
}

/**
 * Check every catalog, against every language, with every enabled rule.
 *
 * The whole repository is in scope on every run. There is no diff, no base
 * branch and no incremental path: whether a German string is missing does not
 * depend on which commit dropped it.
 */
export function analyze(
  catalogs: Catalog[],
  config: ResolvedConfig,
  options: AnalyzeOptions = {},
): AnalysisResult {
  const { ignoresKey, ignoresFile } = createIgnoreMatchers(config)
  const inScope = catalogs.filter((catalog) => !ignoresFile(catalog.path))

  // Default is every language found anywhere, not per-catalog: a module that is
  // simply absent from one locale is exactly the gap worth surfacing.
  const discovered = new Set<LanguageCode>()
  for (const catalog of inScope) for (const language of catalog.languages) discovered.add(language)
  const candidates = (config.required ?? [...discovered]).slice().sort()

  const rules = (options.rules ?? ALL_RULES).filter((rule) =>
    rule.classes.some((issueClass) => config.severity[issueClass] !== 'off'),
  )

  const issues: Issue[] = []
  const assessments: CatalogAssessment[] = []
  const sourceLanguages = new Set<LanguageCode>()

  for (const catalog of inScope) {
    const sourceLanguage = config.sourceLanguage ?? catalog.sourceLanguage
    sourceLanguages.add(sourceLanguage)

    const assessment = assessCatalog(catalog, {
      sourceLanguage,
      targets: candidates,
      ignoresKey,
    })
    assessments.push(assessment)

    const report = (pending: PendingIssue): void => {
      const configured = config.severity[pending.class]
      if (configured === 'off') return
      const { forceWarn, ...rest } = pending
      issues.push({
        ...rest,
        catalog: catalog.path,
        severity: forceWarn ? 'warn' : configured,
      })
    }

    for (const rule of rules) rule.run({ assessment, config, ignoresKey, report })
  }

  const coverage = computeCoverage(assessments)

  return {
    catalogs: inScope,
    issues: sortIssues(issues),
    coverage,
    languages: Object.keys(coverage).sort(),
    sourceLanguages: [...sourceLanguages].sort(),
  }
}

const SEVERITY_ORDER = { error: 0, warn: 1 } as const

function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.catalog.localeCompare(b.catalog) ||
      a.loc.line - b.loc.line ||
      a.key.localeCompare(b.key) ||
      (a.language ?? '').localeCompare(b.language ?? '') ||
      a.class.localeCompare(b.class),
  )
}

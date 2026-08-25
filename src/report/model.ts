import type { AnalysisResult } from '../core/analyze.js'
import type { ThresholdShortfall } from '../core/coverage.js'
import {
  ALL_ISSUE_CLASSES,
  STATE_ISSUE_CLASSES,
  type Issue,
  type IssueClass,
} from '../core/types.js'

/** Everything the three reporting surfaces need, computed once by the caller. */
export interface ReportInput {
  passed: boolean
  result: AnalysisResult
  /** Every issue found, errors and warnings together. */
  issues: Issue[]
  /** The issues that decide pass or fail. */
  errors: Issue[]
  /** Reported, never blocking. */
  warnings: Issue[]
  shortfalls: ThresholdShortfall[]
  threshold: number
  /** How many files the globs matched. */
  filesScanned: number
  /** Annotations the per-level cap discarded. */
  annotationsDropped?: number | undefined
}

/** Inline code that survives a Markdown table cell. */
export function code(value: string): string {
  if (value === '') return '``'
  const fence = value.includes('`') ? '``' : '`'
  const padded = value.startsWith('`') || value.endsWith('`') ? ` ${value} ` : value
  return `${fence}${padded.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')}${fence}`
}

export function percent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`
}

export function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n')
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export interface CoverageRow {
  language: string
  percent: number
  translated: number
  translatable: number
  errors: number
}

export function coverageRows(input: ReportInput): CoverageRow[] {
  const errorsByLanguage = new Map<string, number>()
  for (const issue of input.errors) {
    if (!issue.language) continue
    errorsByLanguage.set(issue.language, (errorsByLanguage.get(issue.language) ?? 0) + 1)
  }

  return input.result.languages.map((language) => {
    const coverage = input.result.coverage[language]
    return {
      language,
      percent: coverage?.percent ?? 0,
      translated: coverage?.translated ?? 0,
      translatable: coverage?.translatable ?? 0,
      errors: errorsByLanguage.get(language) ?? 0,
    }
  })
}

export function renderCoverageTable(input: ReportInput): string {
  const rows = coverageRows(input)
  if (rows.length === 0) return '_No target languages found._'

  const shortfalls = new Set(input.shortfalls.map((shortfall) => shortfall.language))
  return table(
    ['Language', 'Coverage', 'Translated', 'Threshold', 'Status'],
    rows.map((row) => [
      code(row.language),
      percent(row.percent),
      `${row.translated} / ${row.translatable}`,
      percent(input.threshold),
      shortfalls.has(row.language) ? '✕ below' : '✓',
    ]),
  )
}

/** Section headings. */
export const CLASS_LABELS: Record<IssueClass, string> = {
  missing: 'Missing translations',
  empty: 'Empty values',
  new: 'Untranslated (new)',
  needsReview: 'Needs review',
  stale: 'Stale keys',
  formatSpecifier: 'Format specifier mismatches',
  pluralCoverage: 'Incomplete plural coverage',
  identicalToSource: 'Identical to the source string',
  duplicateKey: 'Duplicate keys',
  duplicateValue: 'Duplicate source strings',
  orphanKey: 'Orphan keys',
}

/** Short forms, so the summary table stays narrow enough to scan. */
const CLASS_COLUMNS: Record<IssueClass, string> = {
  missing: 'Missing',
  empty: 'Empty',
  new: 'New',
  needsReview: 'Review',
  stale: 'Stale',
  formatSpecifier: 'Format',
  pluralCoverage: 'Plurals',
  identicalToSource: 'Same as source',
  duplicateKey: 'Dup key',
  duplicateValue: 'Dup text',
  orphanKey: 'Orphan',
}

/** Beyond this many codes in one cell, list a few and count the rest. */
const MAX_LANGUAGES_PER_CELL = 8

export interface LanguageGroup {
  languages: string[]
  counts: Record<IssueClass, number>
  total: number
}

/**
 * Group languages that have exactly the same issue counts onto one row.
 *
 * A project shipping eight locales usually breaks all of them the same way, so
 * eight near-identical rows is eight times the reading for the same fact. One
 * row saying `de, es, fr, it, ja, ko, pt-BR, zh-Hans -- 3 missing` is the
 * finding; the per-language split only matters when it actually differs.
 */
export function groupLanguagesByIssues(languages: string[], issues: Issue[]): LanguageGroup[] {
  const empty = (): Record<IssueClass, number> =>
    Object.fromEntries(ALL_ISSUE_CLASSES.map((c) => [c, 0])) as Record<IssueClass, number>

  const perLanguage = new Map<string, Record<IssueClass, number>>(
    languages.map((language) => [language, empty()]),
  )
  for (const issue of issues) {
    if (!issue.language) continue
    const counts = perLanguage.get(issue.language)
    if (counts) counts[issue.class]++
  }

  const grouped = new Map<string, LanguageGroup>()
  for (const [language, counts] of perLanguage) {
    const key = JSON.stringify(counts)
    const existing = grouped.get(key)
    if (existing) existing.languages.push(language)
    else {
      grouped.set(key, {
        languages: [language],
        counts,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
      })
    }
  }

  return [...grouped.values()]
    .map((group) => ({ ...group, languages: group.languages.sort() }))
    .sort((a, b) => b.total - a.total || (a.languages[0] ?? '').localeCompare(b.languages[0] ?? ''))
}

/** `de, fr, ja`, or `all 12 languages` when the group covers every one. */
export function renderLanguageCell(languages: string[], totalLanguages: number): string {
  if (languages.length === 0) return '—'
  if (totalLanguages > 1 && languages.length === totalLanguages) {
    return `all ${totalLanguages} languages`
  }
  if (languages.length > MAX_LANGUAGES_PER_CELL) {
    const shown = languages.slice(0, MAX_LANGUAGES_PER_CELL).map(code).join(', ')
    return `${shown} +${languages.length - MAX_LANGUAGES_PER_CELL} more`
  }
  return languages.map(code).join(', ')
}

/**
 * Counts per language group, with a column only for the classes that actually
 * occurred. Percentages are deliberately absent: "2 missing" is something a
 * reviewer can act on, "98.8%" is not.
 */
export function renderLanguageTable(languages: string[], issues: Issue[]): string {
  // Languages with nothing wrong are dropped: this is a table of problems, and
  // a row of dashes saying "nothing here" is a line of reading for no finding.
  const groups = groupLanguagesByIssues(languages, issues).filter((group) => group.total > 0)
  if (groups.length === 0) return ''

  const classes = ALL_ISSUE_CLASSES.filter((c) => groups.some((g) => g.counts[c] > 0))
  if (classes.length === 0) return ''

  const headers = ['Languages', ...classes.map((c) => CLASS_COLUMNS[c]), 'Total']
  const rows = groups.map((group) => [
    renderLanguageCell(group.languages, languages.length),
    ...classes.map((c) => (group.counts[c] === 0 ? '—' : String(group.counts[c]))),
    group.total === 0 ? '✓ clean' : `**${group.total}**`,
  ])
  return table(headers, rows)
}

/**
 * One collapsed block per issue class, naming the keys involved.
 *
 * Split by class rather than one flat list because the classes need different
 * fixes: a missing key needs a translator, a format specifier mismatch needs a
 * developer, and mixing them buries the second in the first.
 */
export interface KeySectionOptions {
  /**
   * Wrap each class in its own `<details>`. Turn this off when the sections
   * already sit inside one -- GitHub renders nested `<details>` but it reads
   * like a filing cabinet inside a filing cabinet.
   */
  collapsed?: boolean
}

export function renderKeySections(
  issues: Issue[],
  languages: string[],
  maxRows: number,
  options: KeySectionOptions = {},
): string[] {
  const collapsed = options.collapsed ?? true
  const sections: string[] = []

  for (const issueClass of ALL_ISSUE_CLASSES) {
    const forClass = issues.filter((issue) => issue.class === issueClass)
    if (forClass.length === 0) continue

    const body = (STATE_ISSUE_CLASSES as readonly string[]).includes(issueClass)
      ? renderKeyTable(forClass, languages, maxRows)
      : renderMessageList(forClass, maxRows)

    sections.push(
      collapsed
        ? [
            `<details><summary><b>${CLASS_LABELS[issueClass]}</b> · ${forClass.length}</summary>`,
            '',
            body,
            '',
            '</details>',
          ].join('\n')
        : [`**${CLASS_LABELS[issueClass]}** · ${forClass.length}`, '', body].join('\n'),
    )
  }

  return sections
}

/** Key -> the languages it is missing from, so each key appears once. */
function renderKeyTable(issues: Issue[], languages: string[], maxRows: number): string {
  interface Row {
    catalog: string
    key: string
    languages: string[]
  }
  const rows = new Map<string, Row>()
  for (const issue of issues) {
    const id = JSON.stringify([issue.catalog, issue.key])
    let row = rows.get(id)
    if (!row) {
      row = { catalog: issue.catalog, key: issue.key, languages: [] }
      rows.set(id, row)
    }
    if (issue.language) row.languages.push(issue.language)
  }

  const all = [...rows.values()]
  // Widest blast radius first: a key missing everywhere matters more than one
  // missing in a single locale.
  all.sort((a, b) => b.languages.length - a.languages.length || a.key.localeCompare(b.key))

  const showCatalog = new Set(all.map((r) => r.catalog)).size > 1
  const shown = all.slice(0, maxRows)
  const headers = [...(showCatalog ? ['Catalog'] : []), 'Key', 'Languages']
  const body = shown.map((row) => [
    ...(showCatalog ? [code(row.catalog)] : []),
    code(row.key),
    renderLanguageCell(row.languages.sort(), languages.length),
  ])

  const rendered = table(headers, body)
  return all.length > shown.length
    ? `${rendered}\n\n_+ ${all.length - shown.length} more keys._`
    : rendered
}

/** Structural issues carry a specific message, so they read better as a list. */
function renderMessageList(issues: Issue[], maxRows: number): string {
  const shown = issues.slice(0, maxRows)
  const lines = shown.map((issue) => `- ${code(issue.key)} — ${issue.message}`)
  if (issues.length > shown.length) {
    lines.push('', `_+ ${issues.length - shown.length} more._`)
  }
  return lines.join('\n')
}

import type { AnalysisResult } from '../core/analyze.js'
import type { Mode, RatchetComparison, ThresholdShortfall } from '../core/ratchet.js'
import { STATE_ISSUE_CLASSES, type Issue, type StateIssueClass } from '../core/types.js'

/** Everything the three reporting surfaces need, computed once by the caller. */
export interface ReportInput {
  mode: Mode
  passed: boolean
  /** Head analysis. In ratchet mode this is the language-unified one. */
  result: AnalysisResult
  /** Every issue at head, whether or not it gates. */
  allIssues: Issue[]
  /**
   * The issues that actually decide pass or fail: newly introduced ones in
   * ratchet mode, all errors in absolute mode.
   */
  blocking: Issue[]
  comparison?: RatchetComparison | undefined
  shortfalls?: ThresholdShortfall[] | undefined
  threshold?: number | undefined
  /** Base branch name for display, e.g. `main`. */
  baseRef?: string | undefined
  /** Annotations the per-level cap discarded. */
  annotationsDropped?: number | undefined
}

/* -------------------------------------------------------------------------- */
/* Markdown helpers                                                            */
/* -------------------------------------------------------------------------- */

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

export function delta(before: number | undefined, after: number): string {
  if (before === undefined) return 'new'
  const difference = Math.round((after - before) * 10) / 10
  if (difference === 0) return '—'
  return `${difference < 0 ? '🔻' : '🔺'} ${percent(Math.abs(difference))}`
}

export function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n')
}

/* -------------------------------------------------------------------------- */
/* Coverage                                                                    */
/* -------------------------------------------------------------------------- */

export interface CoverageRow {
  language: string
  before?: number | undefined
  after: number
  blocking: number
}

export function coverageRows(input: ReportInput): CoverageRow[] {
  const blockingByLanguage = new Map<string, number>()
  for (const issue of input.blocking) {
    if (!issue.language) continue
    blockingByLanguage.set(issue.language, (blockingByLanguage.get(issue.language) ?? 0) + 1)
  }

  return input.result.languages.map((language) => ({
    language,
    before: input.comparison?.baseCoverage[language]?.percent,
    after: input.result.coverage[language]?.percent ?? 0,
    blocking: blockingByLanguage.get(language) ?? 0,
  }))
}

export function renderCoverageTable(input: ReportInput): string {
  const rows = coverageRows(input)
  if (rows.length === 0) return '_No target languages found._'

  if (input.mode === 'ratchet') {
    return table(
      ['Language', 'Before', 'After', 'Δ', 'New issues'],
      rows.map((row) => [
        code(row.language),
        row.before === undefined ? '—' : percent(row.before),
        percent(row.after),
        delta(row.before, row.after),
        row.blocking === 0 ? '0' : `**${row.blocking}**`,
      ]),
    )
  }

  const threshold = input.threshold ?? 100
  return table(
    ['Language', 'Coverage', 'Threshold', 'Status'],
    rows.map((row) => [
      code(row.language),
      percent(row.after),
      percent(threshold),
      row.after >= threshold ? '✓' : '✕ below',
    ]),
  )
}

/* -------------------------------------------------------------------------- */
/* Issue detail                                                                */
/* -------------------------------------------------------------------------- */

const CELL: Record<StateIssueClass, string> = {
  missing: '✕ missing',
  empty: '⚠ empty',
  new: '⚠ new',
  needsReview: '⚠ review',
  stale: '⚠ stale',
}

const isStateClass = (issue: Issue): issue is Issue & { class: StateIssueClass } =>
  (STATE_ISSUE_CLASSES as readonly string[]).includes(issue.class)

/** Above this, a key-by-language matrix is wider than it is useful. */
const MAX_MATRIX_LANGUAGES = 6

/**
 * Render the per-key detail.
 *
 * A key-by-language matrix is the most scannable form when there are only a few
 * languages -- one row per key tells you at a glance whether a string is missing
 * everywhere or just in one place. Past a handful of languages the table gets
 * too wide to read in a PR comment, so it degrades to a flat list.
 */
export function renderIssueDetail(issues: Issue[], maxRows: number): string {
  if (issues.length === 0) return ''

  const stateIssues = issues.filter(isStateClass)
  const structural = issues.filter((issue) => !isStateClass(issue))
  // A stale key is dead in every language at once, so it has no language column
  // to sit in and gets its own list rather than a row of identical cells.
  const keyLevel = stateIssues.filter((issue) => !issue.language)
  const pairs = stateIssues.filter((issue) => issue.language)

  const sections: string[] = []
  const languages = [...new Set(pairs.map((issue) => issue.language as string))].sort()
  const catalogs = new Set(pairs.map((issue) => issue.catalog))

  if (pairs.length > 0 && languages.length <= MAX_MATRIX_LANGUAGES) {
    interface Row {
      catalog: string
      key: string
      cells: Map<string, StateIssueClass>
    }
    const rows = new Map<string, Row>()
    const order: string[] = []

    for (const issue of pairs) {
      const id = JSON.stringify([issue.catalog, issue.key])
      let row = rows.get(id)
      if (!row) {
        row = { catalog: issue.catalog, key: issue.key, cells: new Map() }
        rows.set(id, row)
        order.push(id)
      }
      row.cells.set(issue.language as string, issue.class)
    }

    const shown = order.slice(0, maxRows)
    // Only show the catalog column when more than one file is involved,
    // otherwise it is the same string repeated down the table.
    const showCatalog = catalogs.size > 1
    const headers = [...(showCatalog ? ['Catalog'] : []), 'Key', ...languages]
    const body = shown.map((id) => {
      const row = rows.get(id) as Row
      return [
        ...(showCatalog ? [code(row.catalog)] : []),
        code(row.key),
        ...languages.map((language) => {
          const issueClass = row.cells.get(language)
          return issueClass ? CELL[issueClass] : '✓'
        }),
      ]
    })

    sections.push(table(headers, body))
    if (order.length > shown.length) {
      sections.push(`_+ ${pluralise(order.length - shown.length, 'more key')}._`)
    }
  } else if (pairs.length > 0) {
    const shown = pairs.slice(0, maxRows)
    sections.push(shown.map((issue) => `- ${code(issue.key)} — ${issue.message}`).join('\n'))
    if (pairs.length > shown.length) {
      sections.push(`_+ ${pairs.length - shown.length} more._`)
    }
  }

  if (keyLevel.length > 0) {
    const shown = keyLevel.slice(0, maxRows)
    sections.push(
      [
        ...shown.map((issue) => `- ${code(issue.key)} — ${issue.message}`),
        ...(keyLevel.length > shown.length ? [`_+ ${keyLevel.length - shown.length} more._`] : []),
      ].join('\n'),
    )
  }

  if (structural.length > 0) {
    const shown = structural.slice(0, maxRows)
    sections.push(
      [
        '**Structural problems**',
        '',
        ...shown.map((issue) => `- ${code(issue.key)} — ${issue.message}`),
        ...(structural.length > shown.length
          ? [`_+ ${structural.length - shown.length} more._`]
          : []),
      ].join('\n'),
    )
  }

  return sections.filter(Boolean).join('\n\n')
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

import { ALL_ISSUE_CLASSES, type Issue, type IssueClass } from '../core/types.js'
import type { CatalogParseError } from '../core/types.js'
import {
  code,
  pluralise,
  renderCoverageTable,
  renderIssueDetail,
  table,
  type ReportInput,
} from './model.js'

/**
 * The job summary is the surface that always works.
 *
 * It needs no token, survives fork pull requests where the comment API is
 * read-only, and has no annotation cap -- so it carries the complete picture and
 * the other two surfaces can be lossy without anything being lost.
 */

/** $GITHUB_STEP_SUMMARY accepts 1MB; stay well inside it. */
const MAX_SUMMARY_LENGTH = 900_000
const MAX_DETAIL_ROWS = 200

const CLASS_LABELS: Record<IssueClass, string> = {
  missing: 'Missing',
  empty: 'Empty',
  new: 'Untranslated (new)',
  needsReview: 'Needs review',
  stale: 'Stale key',
  formatSpecifier: 'Format specifier mismatch',
  pluralCoverage: 'Incomplete plural coverage',
}

export function renderSummary(input: ReportInput): string {
  const lines: string[] = [
    `## 🌍 xcstrings-lint — ${input.passed ? 'passed' : 'failed'}`,
    '',
    ...describeRun(input),
    '',
    '### Coverage',
    '',
    renderCoverageTable(input),
    '',
  ]

  const breakdown = classBreakdown(input.allIssues)
  if (breakdown.length > 0) {
    lines.push(
      '### Issues found',
      '',
      table(
        ['Class', 'Errors', 'Warnings'],
        breakdown.map((row) => [row.label, String(row.errors), String(row.warnings)]),
      ),
      '',
    )
  }

  if (input.blocking.length > 0) {
    // Not "blocking": this set includes warnings, which do not fail the run.
    // The `issue-count` output counts errors only.
    const label = input.mode === 'ratchet' ? 'New issues' : 'Issues'
    lines.push(
      `<details open><summary>${label} (${input.blocking.length})</summary>`,
      '',
      renderIssueDetail(input.blocking, MAX_DETAIL_ROWS),
      '',
      '</details>',
      '',
    )
  }

  // Everything at head, gating or not. This is the list the annotation cap and
  // the comment's own limits are allowed to truncate away from.
  const carried = input.allIssues.filter((issue) => !input.blocking.includes(issue))
  if (carried.length > 0) {
    lines.push(
      `<details><summary>Pre-existing issues (${carried.length})</summary>`,
      '',
      renderIssueDetail(carried, MAX_DETAIL_ROWS),
      '',
      '</details>',
      '',
    )
  }

  const fixed = input.comparison?.fixedIssues ?? []
  if (fixed.length > 0) {
    lines.push(
      `<details><summary>Fixed on this branch (${fixed.length})</summary>`,
      '',
      renderIssueDetail(fixed, MAX_DETAIL_ROWS),
      '',
      '</details>',
      '',
    )
  }

  if (input.annotationsDropped) {
    lines.push(
      `_${input.annotationsDropped} annotations were not shown inline; GitHub caps them per step._`,
      '',
    )
  }

  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  return body.length > MAX_SUMMARY_LENGTH
    ? `${body.slice(0, MAX_SUMMARY_LENGTH)}\n\n_Summary truncated._`
    : body
}

function describeRun(input: ReportInput): string[] {
  const base = input.baseRef ? code(input.baseRef) : 'the base branch'
  const catalogs = pluralise(input.result.catalogs.length, 'catalog')
  const languages = pluralise(input.result.languages.length, 'language')

  if (input.mode === 'ratchet') {
    const headline =
      input.blocking.length === 0
        ? `No new localization issues vs ${base}.`
        : `${pluralise(input.blocking.length, 'new issue')} vs ${base}.`
    return [headline, '', `Checked ${catalogs} across ${languages}.`]
  }

  const threshold = input.threshold ?? 100
  const shortfalls = input.shortfalls ?? []
  const headline =
    shortfalls.length === 0
      ? `Every language is at or above ${threshold}% coverage.`
      : `${pluralise(shortfalls.length, 'language')} below the ${threshold}% threshold.`
  return [headline, '', `Checked ${catalogs} across ${languages}.`]
}

interface ClassRow {
  label: string
  errors: number
  warnings: number
}

function classBreakdown(issues: Issue[]): ClassRow[] {
  return ALL_ISSUE_CLASSES.map((issueClass) => {
    const matching = issues.filter((issue) => issue.class === issueClass)
    return {
      label: CLASS_LABELS[issueClass],
      errors: matching.filter((issue) => issue.severity === 'error').length,
      warnings: matching.filter((issue) => issue.severity === 'warn').length,
    }
  }).filter((row) => row.errors > 0 || row.warnings > 0)
}

/**
 * Parse failures get their own block. These are a different kind of problem
 * from an incomplete translation -- the tool could not read the file at all --
 * and they exit 2 rather than 1.
 */
export function renderParseErrors(errors: CatalogParseError[]): string {
  if (errors.length === 0) return ''
  return [
    `## 🌍 xcstrings-lint — could not read ${pluralise(errors.length, 'file')}`,
    '',
    ...errors.map((error) => `- ${code(error.file)} — ${error.message}`),
    '',
    '_This is a configuration or file problem, not a translation gap._',
  ].join('\n')
}

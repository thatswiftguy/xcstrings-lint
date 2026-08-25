import type { CatalogParseError } from '../core/types.js'
import {
  code,
  pluralise,
  renderCoverageTable,
  renderKeySections,
  renderLanguageTable,
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

export function renderSummary(input: ReportInput): string {
  const languages = input.result.languages
  const lines: string[] = [
    `## 🌍 xcstrings-lint — ${input.passed ? 'passed' : 'failed'}`,
    '',
    ...describeRun(input),
    '',
  ]

  if (input.blocking.length > 0) {
    const heading = input.mode === 'ratchet' ? 'New issues' : 'Issues'
    lines.push(`### ${heading}`, '')
    const grouped = renderLanguageTable(languages, input.blocking)
    if (grouped) lines.push(grouped, '')
    for (const section of renderKeySections(input.blocking, languages, MAX_DETAIL_ROWS)) {
      lines.push(section, '')
    }
  }

  // Percentages live here and not in the PR comment: this is the surface people
  // open when they want the standing number, rather than the one thing that
  // changed in front of them.
  lines.push('### Coverage', '', renderCoverageTable(input), '')

  const carried = input.allIssues.filter((issue) => !input.blocking.includes(issue))
  if (carried.length > 0) {
    lines.push(
      `<details><summary>Pre-existing issues · ${carried.length}</summary>`,
      '',
      renderLanguageTable(languages, carried),
      '',
      ...renderKeySections(carried, languages, MAX_DETAIL_ROWS),
      '',
      '</details>',
      '',
    )
  }

  const fixed = input.comparison?.fixedIssues ?? []
  if (fixed.length > 0) {
    lines.push(
      `<details><summary>Fixed on this branch · ${fixed.length}</summary>`,
      '',
      ...renderKeySections(fixed, languages, MAX_DETAIL_ROWS),
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

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

  if (input.errors.length > 0) {
    lines.push('### Issues', '')
    const grouped = renderLanguageTable(languages, input.errors)
    if (grouped) lines.push(grouped, '')
    for (const section of renderKeySections(input.errors, languages, MAX_DETAIL_ROWS)) {
      lines.push(section, '')
    }
  }

  // Percentages live here and not in the PR comment: this is the surface people
  // open when they want the standing number, rather than the one thing that
  // changed in front of them.
  lines.push('### Coverage', '', renderCoverageTable(input), '')

  if (input.warnings.length > 0) {
    lines.push(
      `<details><summary>Warnings · ${input.warnings.length}</summary>`,
      '',
      renderLanguageTable(languages, input.warnings),
      '',
      ...renderKeySections(input.warnings, languages, MAX_DETAIL_ROWS, { collapsed: false }),
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
  const scope =
    `Checked ${pluralise(input.filesScanned, 'file')} — ` +
    `${pluralise(input.result.catalogs.length, 'catalog')} across ` +
    `${pluralise(input.result.languages.length, 'language')}.`

  const shortfalls = input.shortfalls
  const headline =
    input.errors.length === 0 && shortfalls.length === 0
      ? `Every language is at or above ${input.threshold}% coverage.`
      : [
          input.errors.length > 0 ? pluralise(input.errors.length, 'blocking issue') : '',
          shortfalls.length > 0
            ? `${pluralise(shortfalls.length, 'language')} below the ${input.threshold}% threshold`
            : '',
        ]
          .filter(Boolean)
          .join(', ') + '.'

  return [headline, '', scope]
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

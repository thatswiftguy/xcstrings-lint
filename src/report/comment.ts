import {
  carriedIssues,
  code,
  pluralise,
  renderKeySections,
  renderLanguageTable,
  warningIssues,
  type ReportInput,
} from './model.js'

/**
 * Hidden marker used to find our own comment on re-runs.
 *
 * The comment is sticky: we search the PR for this marker and PATCH the comment
 * that carries it, so a branch with twenty pushes has one comment, not twenty.
 */
export const COMMENT_MARKER = '<!-- xcstrings-lint -->'

/** GitHub rejects comment bodies over 65536 characters. Leave headroom. */
export const MAX_COMMENT_LENGTH = 60000

const MAX_DETAIL_ROWS = 40
/** Context, not the finding -- show less of it. */
const MAX_CONTEXT_ROWS = 20

/**
 * Render the sticky comment.
 *
 * Layout is deliberately two-tier. A reviewer opening the PR should learn what
 * is broken and where in about three seconds -- one headline, one grouped
 * table -- and everything past that is collapsed until they ask for it. The
 * detail matters, but not before they know whether it concerns them.
 */
export function renderComment(input: ReportInput): string {
  const status = input.passed ? '**passed**' : '**failed**'
  const lines: string[] = [`### 🌍 xcstrings-lint — ${status}`, '', headline(input), '']

  const summary = renderLanguageTable(input.result.languages, input.blocking)
  if (summary) lines.push(summary, '')

  for (const section of renderKeySections(input.blocking, input.result.languages, MAX_DETAIL_ROWS)) {
    lines.push(section, '')
  }

  // Everything that does not block gets a section of its own rather than a bare
  // count, and pre-existing problems are kept apart from warnings. A reviewer
  // who wants to know what else is off should not have to guess which of these
  // two very different things they are looking at.
  lines.push(
    ...collapsedSection(input, carriedIssues(input), 'Pre-existing issues', 'not introduced by this change'),
    ...collapsedSection(input, warningIssues(input), 'Warnings', 'not blocking'),
  )

  if (input.fixed.length > 0) {
    lines.push(`✅ ${pluralise(input.fixed.length, 'issue')} fixed by this change.`, '')
  }

  lines.push(footer(input))
  return truncate(lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd())
}

function collapsedSection(
  input: ReportInput,
  issues: ReportInput['issues'],
  label: string,
  note: string,
): string[] {
  if (issues.length === 0) return []
  const body = [
    renderLanguageTable(input.result.languages, issues),
    ...renderKeySections(issues, input.result.languages, MAX_CONTEXT_ROWS, { collapsed: false }),
  ].filter(Boolean)
  return [
    `<details><summary><b>${label}</b> · ${issues.length} — ${note}</summary>`,
    '',
    body.join('\n\n'),
    '',
    '</details>',
    '',
  ]
}

function headline(input: ReportInput): string {
  const base = input.baseLabel ? code(input.baseLabel) : 'the base branch'

  if (input.blocking.length === 0) {
    if (input.shortfalls.length > 0) {
      return (
        `**${pluralise(input.shortfalls.length, 'language')}** below the ${input.threshold}% threshold: ` +
        input.shortfalls.map((s) => `\`${s.language}\` at ${s.percent}%`).join(', ') +
        '.'
      )
    }
    if (input.mode === 'ratchet') return `No new localization issues vs ${base}.`
    return `Every language is fully translated across ${pluralise(input.filesScanned, 'file')}.`
  }

  const keys = new Set(input.blocking.map((issue) => JSON.stringify([issue.catalog, issue.key]))).size
  const languages = new Set(input.blocking.map((issue) => issue.language).filter(Boolean)).size
  const noun = input.mode === 'ratchet' ? 'new issue' : 'issue'
  const against = input.mode === 'ratchet' ? ` vs ${base}` : ''

  return (
    `**${pluralise(input.blocking.length, noun)}**${against} — ` +
    `${pluralise(keys, 'key')} across ${pluralise(languages, 'language')}.`
  )
}

function footer(input: ReportInput): string {
  const parts = [`${pluralise(input.filesScanned, 'file')} checked`]
  if (input.mode === 'ratchet') parts.push('gate: new issues only')
  if (input.annotationsDropped) {
    parts.push(`${input.annotationsDropped} annotations not shown inline — see the job summary`)
  }
  return `<sub>${parts.join(' · ')} · ${COMMENT_MARKER}</sub>`
}

/**
 * Trim an over-long body without losing the marker, which is what makes the
 * comment sticky -- a truncated body that dropped it would orphan the comment
 * and post a fresh one on every push.
 */
export function truncate(body: string, limit = MAX_COMMENT_LENGTH): string {
  if (body.length <= limit) return body

  const notice = '\n\n_Report truncated._\n'
  const marker = body.endsWith('</sub>') ? `\n<sub>${COMMENT_MARKER}</sub>` : `\n${COMMENT_MARKER}`
  const room = limit - notice.length - marker.length
  return `${body.slice(0, Math.max(0, room)).trimEnd()}${notice}${marker}`
}

export function isOurComment(body: string | undefined | null): boolean {
  return typeof body === 'string' && body.includes(COMMENT_MARKER)
}

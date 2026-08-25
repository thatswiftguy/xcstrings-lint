import { pluralise, renderKeySections, renderLanguageTable, type ReportInput } from './model.js'

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
/** Warnings are context, not the finding -- show less of them. */
const MAX_WARNING_ROWS = 20

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

  const summary = renderLanguageTable(input.result.languages, input.errors)
  if (summary) lines.push(summary, '')

  for (const section of renderKeySections(input.errors, input.result.languages, MAX_DETAIL_ROWS)) {
    lines.push(section, '')
  }

  // Warnings get a section of their own rather than a bare count. They do not
  // block the merge, so they stay collapsed and out of the headline -- but a
  // reviewer who wants to know what else is off should not have to go digging
  // through the job summary to find out.
  if (input.warnings.length > 0) {
    const body = [
      renderLanguageTable(input.result.languages, input.warnings),
      ...renderKeySections(input.warnings, input.result.languages, MAX_WARNING_ROWS, {
        collapsed: false,
      }),
    ].filter(Boolean)
    lines.push(
      `<details><summary><b>Warnings</b> · ${input.warnings.length} — not blocking</summary>`,
      '',
      body.join('\n\n'),
      '',
      '</details>',
      '',
    )
  }

  lines.push(footer(input))
  return truncate(lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd())
}

function headline(input: ReportInput): string {
  const shortfalls = input.shortfalls
  if (input.errors.length === 0 && shortfalls.length === 0) {
    return `Every language is fully translated across ${pluralise(input.filesScanned, 'file')}.`
  }

  if (input.errors.length === 0) {
    return (
      `**${pluralise(shortfalls.length, 'language')}** below the ${input.threshold}% threshold: ` +
      shortfalls.map((s) => `\`${s.language}\` at ${s.percent}%`).join(', ') +
      '.'
    )
  }

  const keys = new Set(input.errors.map((issue) => JSON.stringify([issue.catalog, issue.key]))).size
  const languages = new Set(input.errors.map((issue) => issue.language).filter(Boolean)).size
  return (
    `**${pluralise(input.errors.length, 'issue')}** — ` +
    `${pluralise(keys, 'key')} across ${pluralise(languages, 'language')}.`
  )
}

function footer(input: ReportInput): string {
  const parts = [`${pluralise(input.filesScanned, 'file')} checked`]
  if (input.warnings.length > 0) parts.push(`${pluralise(input.warnings.length, 'warning')}`)
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

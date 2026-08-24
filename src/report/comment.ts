import {
  code,
  pluralise,
  renderCoverageTable,
  renderIssueDetail,
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

export function renderComment(input: ReportInput): string {
  const status = input.passed ? '**passed**' : '**failed**'
  const lines: string[] = [`### 🌍 xcstrings-lint — ${status}`, '', headline(input), '']

  lines.push(renderCoverageTable(input), '')

  const detail = renderIssueDetail(input.blocking, MAX_DETAIL_ROWS)
  if (detail) {
    const label = input.mode === 'ratchet' ? 'New issues' : 'Issues'
    lines.push(
      `<details><summary>${label} (${input.blocking.length})</summary>`,
      '',
      detail,
      '',
      '</details>',
      '',
    )
  }

  const fixed = input.comparison?.fixedIssues.length ?? 0
  if (fixed > 0) lines.push(`✅ ${pluralise(fixed, 'issue')} fixed on this branch.`, '')

  const carried = input.allIssues.length - input.blocking.length
  if (input.mode === 'ratchet' && carried > 0) {
    lines.push(
      `<sub>${pluralise(carried, 'pre-existing issue')} not counted against this PR.</sub>`,
      '',
    )
  }

  lines.push(footer(input))
  return truncate(lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd())
}

function headline(input: ReportInput): string {
  const base = input.baseRef ? code(input.baseRef) : 'the base branch'

  if (input.mode === 'ratchet') {
    if (input.blocking.length === 0) {
      return `No new localization issues vs ${base}.`
    }
    const languages = new Set(input.blocking.map((i) => i.language).filter(Boolean))
    const where =
      languages.size > 0 ? ` across ${pluralise(languages.size, 'language')}` : ''
    return `**${pluralise(input.blocking.length, 'new issue')}**${where} vs ${base}.`
  }

  const threshold = input.threshold ?? 100
  const shortfalls = input.shortfalls ?? []
  if (shortfalls.length === 0) {
    return `Every language is at or above ${threshold}% coverage.`
  }
  return `**${pluralise(shortfalls.length, 'language')}** below the ${threshold}% threshold: ${shortfalls
    .map((s) => `${code(s.language)} at ${s.percent}%`)
    .join(', ')}.`
}

function footer(input: ReportInput): string {
  const parts = [`Mode: \`${input.mode}\``]
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

/** Does this body belong to us? Used to decide PATCH versus POST. */
export function isOurComment(body: string | undefined | null): boolean {
  return typeof body === 'string' && body.includes(COMMENT_MARKER)
}

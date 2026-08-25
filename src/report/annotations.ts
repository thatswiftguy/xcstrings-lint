import type { Issue } from '../core/types.js'

export interface Annotation {
  level: 'error' | 'warning'
  file: string
  line: number
  column?: number
  title: string
  message: string
}

export interface AnnotationPlan {
  annotations: Annotation[]
  dropped: { error: number; warning: number }
  get totalDropped(): number
}

/**
 * GitHub renders at most ten annotations per level per step from workflow
 * commands, so the cap is per level rather than global -- ten errors *and* ten
 * warnings both show. Everything else is in the job summary, which has no such
 * limit and costs nothing.
 */
export const DEFAULT_MAX_PER_LEVEL = 10

const TITLES: Record<Issue['class'], string> = {
  missing: 'Missing translation',
  empty: 'Empty translation',
  new: 'Untranslated string',
  needsReview: 'Translation needs review',
  stale: 'Stale key',
  formatSpecifier: 'Format specifier mismatch',
  pluralCoverage: 'Incomplete plural coverage',
  identicalToSource: 'Identical to the source string',
  duplicateKey: 'Duplicate key',
  duplicateValue: 'Duplicate source string',
  orphanKey: 'Orphan key',
}

export function planAnnotations(
  issues: Issue[],
  maxPerLevel: number = DEFAULT_MAX_PER_LEVEL,
): AnnotationPlan {
  const dropped = { error: 0, warning: 0 }
  const counts = { error: 0, warning: 0 }
  const annotations: Annotation[] = []

  // Errors first, then by file and line, so the ten that survive the cap are
  // the ten worth looking at rather than whichever happened to sort first.
  const ordered = [...issues].sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) ||
      a.loc.file.localeCompare(b.loc.file) ||
      a.loc.line - b.loc.line ||
      a.key.localeCompare(b.key),
  )

  for (const issue of ordered) {
    const level = issue.severity === 'error' ? 'error' : 'warning'
    if (counts[level] >= maxPerLevel) {
      dropped[level]++
      continue
    }
    counts[level]++
    annotations.push({
      level,
      file: issue.loc.file,
      line: issue.loc.line,
      ...(issue.loc.column === undefined ? {} : { column: issue.loc.column }),
      title: `${TITLES[issue.class]}: ${issue.key}`,
      message: issue.message,
    })
  }

  return {
    annotations,
    dropped,
    get totalDropped() {
      return dropped.error + dropped.warning
    },
  }
}

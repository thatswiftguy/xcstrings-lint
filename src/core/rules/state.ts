import { STATE_ISSUE_CLASSES, type LanguageCode, type StateIssueClass } from '../types.js'
import type { Rule } from './rule.js'

/**
 * The five mutually exclusive translation states, plus Xcode's own verdict that
 * a key is no longer referenced in source.
 *
 * All the work happened in the assessment; this rule only turns it into
 * messages. That is deliberate -- the coverage percentage is derived from the
 * same assessment, so the number and the list can never disagree.
 */
export const stateRule: Rule = {
  name: 'state',
  classes: STATE_ISSUE_CLASSES,

  run({ assessment, report }) {
    for (const { entry, pairs } of assessment.entries) {
      // Xcode telling us the key is gone from source is a fact about the key,
      // not about any one language. Fanning it out across 30 locales would bury
      // everything else in the report.
      if (entry.extractionState === 'stale') {
        report({
          class: 'stale',
          key: entry.key,
          loc: entry.loc,
          message: `"${entry.key}" is no longer referenced in source (extractionState: stale)`,
        })
      }

      for (const pair of pairs) {
        if (!pair.stateClass) continue
        report({
          class: pair.stateClass,
          key: entry.key,
          language: pair.language,
          loc: pair.loc,
          message: stateMessage(pair.stateClass, pair.language, pair.detail),
          ...(pair.detail === undefined ? {} : { detail: pair.detail }),
        })
      }
    }
  },
}

function stateMessage(
  stateClass: StateIssueClass,
  language: LanguageCode,
  detail?: string,
): string {
  const where = detail ? ` (${detail})` : ''
  switch (stateClass) {
    case 'missing':
      return `no ${language} translation${where}`
    case 'empty':
      return `${language} translation is empty${where}`
    case 'new':
      return `${language} is marked new -- extracted but not translated${where}`
    case 'needsReview':
      return `${language} is marked needs_review${where}`
    case 'stale':
      return `${language} is marked stale${where}`
  }
}

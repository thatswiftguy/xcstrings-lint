import { duplicateKeyRule, duplicateValueRule } from './duplicates.js'
import { formatSpecifierRule } from './format-specifiers.js'
import { identicalToSourceRule } from './identical-to-source.js'
import { orphanKeyRule } from './orphan-keys.js'
import { pluralCoverageRule } from './plural-coverage.js'
import { stateRule } from './state.js'
import type { Rule } from './rule.js'

export type { PendingIssue, Rule, RuleContext } from './rule.js'

/**
 * Every check, in report order.
 *
 * Adding one is adding a file here and a severity in `config.ts`; nothing in
 * the analyzer, the reporters or the annotation planner needs to know it
 * exists, because they all work from `ALL_ISSUE_CLASSES`.
 */
export const ALL_RULES: readonly Rule[] = [
  stateRule,
  formatSpecifierRule,
  pluralCoverageRule,
  duplicateKeyRule,
  duplicateValueRule,
  orphanKeyRule,
  identicalToSourceRule,
]

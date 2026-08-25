import type { CatalogAssessment } from '../assess.js'
import type { ResolvedConfig } from '../config.js'
import type { Issue, IssueClass } from '../types.js'

/**
 * An issue as a rule reports it.
 *
 * `catalog` and `severity` are filled in by the runner: the catalog because the
 * rule is already scoped to one, and the severity because it comes from config
 * and no rule should be re-reading that. A rule that genuinely knows better --
 * a format width change is a bug but not a crash -- says so with `forceWarn`
 * rather than by setting a severity of its own.
 */
export type PendingIssue = Omit<Issue, 'severity' | 'catalog'> & { forceWarn?: boolean }

export interface RuleContext {
  assessment: CatalogAssessment
  config: ResolvedConfig
  /** True for a key the user asked us to skip. */
  ignoresKey: (key: string) => boolean
  report: (issue: PendingIssue) => void
}

/**
 * One check, over one catalog.
 *
 * Rules never decide whether they run: the runner skips any rule whose classes
 * are all switched off, and drops individual issues whose class is off. That
 * keeps "is this check enabled" in exactly one place instead of seven.
 */
export interface Rule {
  name: string
  /** Every class this rule can emit. Used to skip it when all are off. */
  classes: readonly IssueClass[]
  run: (context: RuleContext) => void
}

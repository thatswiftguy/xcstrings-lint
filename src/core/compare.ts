import type { AnalysisResult } from './analyze.js'
import type { CatalogParseError, Issue } from './types.js'

/**
 * Telling a developer which problems are theirs.
 *
 * The check always reads the whole repository -- the comparison never narrows
 * what gets looked at. All it does is answer the question a reviewer actually
 * asks in front of a long list: *did I do this?* Twenty-eight pre-existing gaps
 * and one new one is a very different conversation from twenty-nine gaps, and
 * without the split the new one is invisible.
 *
 * The comparison is semantic, never textual. Xcode rewrites large regions of
 * `.xcstrings` JSON on every build, so a text diff of these files is almost
 * pure noise; both sides are parsed into issue sets and the sets are compared.
 */

/**
 * Identity of an issue for comparison purposes.
 *
 * The five state classes share one identity per (catalog, key, language),
 * because they are mutually exclusive states of the same pair -- a translation
 * that goes from `new` to `empty` is still the same untranslated string and
 * must not register as a fresh regression. Every other class gets its own
 * identity, because a format-specifier break in an already-`needs_review`
 * string is genuinely a new problem.
 */
export function issueIdentity(issue: Issue): string {
  const group =
    issue.class === 'missing' ||
    issue.class === 'empty' ||
    issue.class === 'new' ||
    issue.class === 'needsReview' ||
    issue.class === 'stale'
      ? 'state'
      : issue.class
  // JSON-encoded so no separator can collide with a path, key or language.
  return JSON.stringify([issue.catalog, issue.key, issue.language ?? null, group])
}

export interface Comparison {
  /** Revision the working tree was compared against, e.g. `origin/main`. */
  baseLabel: string
  /** Issues at head that the base does not have. */
  newIssues: Issue[]
  /** Issues at head that the base has too. Never this change's fault. */
  preExisting: Issue[]
  /** Issues the base had and head does not. Shown as credit, never as a gate. */
  fixed: Issue[]
  /** Parse failures on the base side, which make the comparison untrustworthy. */
  baseErrors: CatalogParseError[]
}

export interface CompareOptions {
  baseLabel: string
  baseErrors?: CatalogParseError[]
}

export function compareIssues(
  head: AnalysisResult,
  base: AnalysisResult,
  options: CompareOptions,
): Comparison {
  const baseIdentities = new Set(base.issues.map(issueIdentity))
  const headIdentities = new Set(head.issues.map(issueIdentity))

  const newIssues: Issue[] = []
  const preExisting: Issue[] = []
  for (const issue of head.issues) {
    if (baseIdentities.has(issueIdentity(issue))) preExisting.push(issue)
    else newIssues.push(issue)
  }

  return {
    baseLabel: options.baseLabel,
    newIssues,
    preExisting,
    fixed: base.issues.filter((issue) => !headIdentities.has(issueIdentity(issue))),
    baseErrors: options.baseErrors ?? [],
  }
}

/**
 * The union of every language either side knows about.
 *
 * Both sides have to be assessed against the same set, or adding a language
 * makes every one of its keys look like a fresh regression and removing one
 * makes the whole locale look fixed.
 */
export function unifiedLanguages(...groups: Array<{ languages: string[] }[]>): string[] {
  const languages = new Set<string>()
  for (const group of groups) {
    for (const catalog of group) for (const language of catalog.languages) languages.add(language)
  }
  return [...languages].sort()
}

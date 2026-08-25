import { missingPluralCategories } from './cldr-plurals.js'
import { compareFormatSpecifiers, parseFormatSpecifiers } from './format-specifiers.js'
import { createIgnoreMatchers, type ResolvedConfig } from './config.js'
import { collectLeaves, findVariationGroups, leafPathLabel } from './value-node.js'
import {
  STATE_PRECEDENCE,
  type Catalog,
  type CatalogEntry,
  type Issue,
  type LanguageCoverage,
  type LanguageCode,
  type Leaf,
  type Localization,
  type SourceLocation,
  type StateIssueClass,
} from './types.js'

export interface AnalysisResult {
  catalogs: Catalog[]
  issues: Issue[]
  /** Keyed by language. Source languages are excluded. */
  coverage: Record<LanguageCode, LanguageCoverage>
  /** Target languages actually assessed, sorted. */
  languages: LanguageCode[]
}

/**
 * Assessment of one (key, language) pair.
 *
 * `stateClass` is the single winning class after precedence -- a unit that is
 * both `new` and `empty` is reported once, not twice, or the totals lie.
 */
interface PairAssessment {
  stateClass?: StateIssueClass
  detail?: string
  loc: SourceLocation
  /** Whether this pair counts toward coverage. `needs_review` still does. */
  complete: boolean
}

export interface AnalyzeOptions {
  /**
   * Force the target language set instead of discovering it from the catalogs.
   *
   * The ratchet depends on this: if each side discovers its own languages, a PR
   * that deletes the last German string makes German disappear from head's
   * discovered set, and the regression reads as "everything fixed".
   */
  languages?: string[] | undefined
}

export function analyze(
  catalogs: Catalog[],
  config: ResolvedConfig,
  options: AnalyzeOptions = {},
): AnalysisResult {
  const { ignoresKey, ignoresFile } = createIgnoreMatchers(config)
  const inScope = catalogs.filter((catalog) => !ignoresFile(catalog.path))

  const sourceLanguages = new Set(
    inScope.map((catalog) => config.sourceLanguage ?? catalog.sourceLanguage),
  )

  // Default is every language found anywhere, not per-catalog: a module that is
  // simply absent from one locale is exactly the gap worth surfacing.
  const discovered = new Set<LanguageCode>()
  for (const catalog of inScope) for (const language of catalog.languages) discovered.add(language)
  const candidates = config.required ?? options.languages ?? [...discovered]

  const issues: Issue[] = []
  const tally = new Map<LanguageCode, { translatable: number; translated: number }>()

  for (const catalog of inScope) {
    const sourceLanguage = config.sourceLanguage ?? catalog.sourceLanguage
    const targets = candidates.filter((language) => language !== sourceLanguage).sort()

    for (const entry of catalog.entries) {
      if (!entry.shouldTranslate || ignoresKey(entry.key)) continue

      if (entry.extractionState === 'stale') {
        push(issues, config, {
          class: 'stale',
          catalog: catalog.path,
          key: entry.key,
          loc: entry.loc,
          message: `"${entry.key}" is no longer referenced in source (extractionState: stale)`,
        })
      }

      const source = sourceReference(entry, sourceLanguage)

      for (const language of targets) {
        const assessment = assess(entry, language, source.leaves)

        const counts = tally.get(language) ?? { translatable: 0, translated: 0 }
        counts.translatable++
        if (assessment.complete) counts.translated++
        tally.set(language, counts)

        if (assessment.stateClass) {
          push(issues, config, {
            class: assessment.stateClass,
            catalog: catalog.path,
            key: entry.key,
            language,
            loc: assessment.loc,
            message: stateMessage(assessment.stateClass, language, assessment.detail),
            ...(assessment.detail === undefined ? {} : { detail: assessment.detail }),
          })
        }
      }

      // Structural checks run against every language present, source included:
      // an English plural that only supplies `other` is wrong too.
      const checked = new Set([...targets, sourceLanguage])
      for (const [language, localization] of Object.entries(entry.localizations)) {
        if (!checked.has(language)) continue
        if (config.severity.formatSpecifier !== 'off' && source.reliable && language !== sourceLanguage) {
          checkFormatSpecifiers(issues, config, catalog, entry, language, localization, source)
        }
        if (config.severity.pluralCoverage !== 'off') {
          checkPluralCoverage(issues, config, catalog, entry, language, localization)
        }
      }
    }
  }

  const coverage: Record<LanguageCode, LanguageCoverage> = {}
  for (const [language, counts] of tally) {
    coverage[language] = {
      language,
      translatable: counts.translatable,
      translated: counts.translated,
      percent:
        counts.translatable === 0
          ? 100
          : Math.round((counts.translated / counts.translatable) * 1000) / 10,
    }
  }

  return {
    catalogs: inScope,
    issues: sortIssues(issues),
    coverage,
    languages: [...tally.keys()].sort(),
  }
}

function assess(
  entry: CatalogEntry,
  language: LanguageCode,
  sourceLeaves: Leaf[],
): PairAssessment {
  const localization = entry.localizations[language]
  if (!localization) {
    return { stateClass: 'missing', loc: entry.loc, complete: false }
  }

  const leaves = collectLeaves(localization)
  const substitutionLeaves = Object.values(localization.substitutions ?? {}).flatMap((s) =>
    collectLeaves(s),
  )
  const all = [...leaves, ...substitutionLeaves]

  if (all.length === 0) {
    return { stateClass: 'missing', loc: localization.loc, complete: false }
  }

  // Every branch the source defines must exist in the target. A German string
  // that covers `device.iphone` but not `device.ipad` is half-translated.
  const present = new Set(leaves.map((leaf) => leafPathLabel(leaf.path)))
  const absent = sourceLeaves
    .map((leaf) => leafPathLabel(leaf.path))
    .filter((label) => label !== '' && !present.has(label))
  if (absent.length > 0) {
    return {
      stateClass: 'missing',
      detail: `missing ${absent.join(', ')}`,
      loc: localization.loc,
      complete: false,
    }
  }

  const candidates: Array<{ class: StateIssueClass; loc: SourceLocation; detail?: string }> = []
  for (const leaf of all) {
    const where = leaf.path.length > 0 ? leafPathLabel(leaf.path) : undefined
    if (leaf.unit.value === '') {
      candidates.push({ class: 'empty', loc: leaf.loc, ...(where ? { detail: where } : {}) })
    }
    if (leaf.unit.state === 'new') {
      candidates.push({ class: 'new', loc: leaf.loc, ...(where ? { detail: where } : {}) })
    } else if (leaf.unit.state === 'needs_review') {
      candidates.push({ class: 'needsReview', loc: leaf.loc, ...(where ? { detail: where } : {}) })
    } else if (leaf.unit.state === 'stale') {
      candidates.push({ class: 'stale', loc: leaf.loc, ...(where ? { detail: where } : {}) })
    }
  }

  const winner = STATE_PRECEDENCE.map((cls) => candidates.find((c) => c.class === cls)).find(
    (c): c is { class: StateIssueClass; loc: SourceLocation; detail?: string } => c !== undefined,
  )

  // `needs_review` has a real value in it, so it still counts as translated --
  // the same call Xcode's own completion percentage makes.
  const complete =
    winner === undefined || (winner.class !== 'empty' && winner.class !== 'new')

  if (!winner) return { loc: localization.loc, complete }
  return {
    stateClass: winner.class,
    ...(winner.detail === undefined ? {} : { detail: winner.detail }),
    loc: winner.loc,
    complete,
  }
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

interface SourceReference {
  leaves: Leaf[]
  substitutions: Record<string, { formatSpecifier?: string }> | undefined
  /**
   * False when we could not establish what the source string actually is. The
   * format check stays silent rather than comparing against a guess.
   */
  reliable: boolean
}

/**
 * Work out the source string for an entry.
 *
 * The source language often has no `localizations` block at all, because with
 * literal keys the key *is* the English text. Falling back to the key is right
 * in that case and wrong for semantic keys like `payment_cvv_hint`, where the
 * key is an identifier -- comparing specifiers against it would invent a
 * mismatch for every translation that legitimately interpolates a value. So we
 * only trust the key when it actually looks like a format string.
 */
function sourceReference(entry: CatalogEntry, sourceLanguage: LanguageCode): SourceReference {
  const localization = entry.localizations[sourceLanguage]
  if (localization) {
    const leaves = collectLeaves(localization)
    if (leaves.length > 0) {
      return {
        leaves,
        substitutions: localization.substitutions,
        reliable: true,
      }
    }
  }

  if (parseFormatSpecifiers(entry.key).length > 0) {
    return {
      leaves: [
        { path: [], unit: { state: 'translated', value: entry.key }, loc: entry.loc },
      ],
      substitutions: undefined,
      reliable: true,
    }
  }

  return { leaves: [], substitutions: undefined, reliable: false }
}

/**
 * Pick the source string a given target leaf should be compared against.
 *
 * Polish `few` has no English counterpart, but every branch of a plural group
 * carries the same arguments, so falling back to the source's `other` branch is
 * both safe and necessary to check expanded plurals at all.
 */
function referenceFor(sourceLeaves: Leaf[], targetPath: Leaf['path']): Leaf | undefined {
  const label = leafPathLabel(targetPath)
  const exact = sourceLeaves.find((leaf) => leafPathLabel(leaf.path) === label)
  if (exact) return exact

  if (targetPath.length > 0) {
    const last = targetPath[targetPath.length - 1]
    if (last?.kind === 'plural') {
      const sibling = leafPathLabel([...targetPath.slice(0, -1), { kind: 'plural', branch: 'other' }])
      const match = sourceLeaves.find((leaf) => leafPathLabel(leaf.path) === sibling)
      if (match) return match
    }
  }

  return sourceLeaves[0]
}

function checkFormatSpecifiers(
  issues: Issue[],
  config: ResolvedConfig,
  catalog: Catalog,
  entry: CatalogEntry,
  language: LanguageCode,
  localization: Localization,
  source: SourceReference,
): void {
  const targets = [
    ...collectLeaves(localization),
    ...Object.values(localization.substitutions ?? {}).flatMap((s) => collectLeaves(s)),
  ]

  for (const leaf of targets) {
    if (leaf.unit.value === '') continue
    const reference = referenceFor(source.leaves, leaf.path)
    if (!reference) continue

    const mismatches = compareFormatSpecifiers(reference.unit.value, leaf.unit.value, {
      sourceSubstitutions: source.substitutions,
      targetSubstitutions: localization.substitutions,
    })

    for (const mismatch of mismatches) {
      const where = leaf.path.length > 0 ? ` [${leafPathLabel(leaf.path)}]` : ''
      push(issues, config, {
        class: 'formatSpecifier',
        catalog: catalog.path,
        key: entry.key,
        language,
        loc: leaf.loc,
        message: `${language}${where}: ${mismatch.message}`,
        detail: `source: ${reference.unit.value}`,
        // A width change is a bug but not a crash, so it never escalates past
        // a warning even when formatSpecifiers is set to error.
        ...(mismatch.severity === 'warn' ? { forceWarn: true } : {}),
      })
    }
  }
}

function checkPluralCoverage(
  issues: Issue[],
  config: ResolvedConfig,
  catalog: Catalog,
  entry: CatalogEntry,
  language: LanguageCode,
  localization: Localization,
): void {
  const groups = [
    ...findVariationGroups(localization, 'plural'),
    ...Object.values(localization.substitutions ?? {}).flatMap((s) =>
      findVariationGroups(s, 'plural'),
    ),
  ]

  for (const { group, path, loc } of groups) {
    const { missing, known } = missingPluralCategories(language, Object.keys(group.branches))
    // Never report against a locale we have no CLDR data for: the one/other
    // fallback is a guess, and a guessed complaint is worse than silence.
    if (!known || missing.length === 0) continue

    const where = path.length > 0 ? ` [${leafPathLabel(path)}]` : ''
    push(issues, config, {
      class: 'pluralCoverage',
      catalog: catalog.path,
      key: entry.key,
      language,
      loc,
      message: `${language}${where} is missing the ${missing.join(', ')} plural ${
        missing.length === 1 ? 'category' : 'categories'
      }`,
      detail: `has ${Object.keys(group.branches).sort().join(', ')}`,
    })
  }
}

type PendingIssue = Omit<Issue, 'severity'> & { forceWarn?: boolean }

function push(issues: Issue[], config: ResolvedConfig, pending: PendingIssue): void {
  const configured = config.severity[pending.class]
  if (configured === 'off') return
  const { forceWarn, ...rest } = pending
  issues.push({ ...rest, severity: forceWarn ? 'warn' : configured })
}

const SEVERITY_ORDER = { error: 0, warn: 1 } as const

function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.catalog.localeCompare(b.catalog) ||
      a.loc.line - b.loc.line ||
      a.key.localeCompare(b.key) ||
      (a.language ?? '').localeCompare(b.language ?? '') ||
      a.class.localeCompare(b.class),
  )
}

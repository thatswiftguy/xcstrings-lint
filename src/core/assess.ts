import { parseFormatSpecifiers } from './parse/format-specifiers.js'
import { collectLeaves, leafPathLabel } from './parse/value-node.js'
import {
  STATE_PRECEDENCE,
  type Catalog,
  type CatalogEntry,
  type LanguageCode,
  type Leaf,
  type SourceLocation,
  type StateIssueClass,
  type Substitution,
} from './types.js'

/**
 * The reading of one catalog that every check shares.
 *
 * Working out what a `(key, language)` pair actually says is the expensive part
 * -- it walks the variation tree and the substitution table -- and four
 * different checks plus the coverage figure all need the answer. Doing it once,
 * here, is what keeps the rules cheap and, more importantly, keeps them
 * agreeing with each other: the percentage and the issue list are computed from
 * the same assessment, so they can never tell two different stories.
 */

/**
 * Assessment of one (key, language) pair.
 *
 * `stateClass` is the single winning class after precedence -- a unit that is
 * both `new` and `empty` is reported once, not twice, or the totals lie.
 */
export interface PairAssessment {
  language: LanguageCode
  stateClass?: StateIssueClass
  detail?: string
  loc: SourceLocation
  /** Whether this pair counts toward coverage. `needs_review` still does. */
  complete: boolean
  /** Every concrete string in this language, variations and substitutions included. */
  leaves: Leaf[]
}

export interface SourceReference {
  leaves: Leaf[]
  substitutions: Record<string, Substitution> | undefined
  /**
   * False when we could not establish what the source string actually is. The
   * format check stays silent rather than comparing against a guess.
   */
  reliable: boolean
  /** True when the source language has an explicit localization block. */
  explicit: boolean
}

export interface EntryAssessment {
  entry: CatalogEntry
  source: SourceReference
  /** One per target language, in the order the targets were given. */
  pairs: PairAssessment[]
}

export interface CatalogAssessment {
  catalog: Catalog
  sourceLanguage: LanguageCode
  /** Target languages assessed for this catalog, sorted, source excluded. */
  targets: LanguageCode[]
  /** Entries in scope: translatable and not ignored. */
  entries: EntryAssessment[]
}

export interface AssessOptions {
  sourceLanguage: LanguageCode
  targets: LanguageCode[]
  /** Returns true for a key the user asked us to skip. */
  ignoresKey: (key: string) => boolean
}

export function assessCatalog(catalog: Catalog, options: AssessOptions): CatalogAssessment {
  const { sourceLanguage, ignoresKey } = options
  const targets = options.targets.filter((language) => language !== sourceLanguage).sort()

  const entries: EntryAssessment[] = []
  for (const entry of catalog.entries) {
    if (!entry.shouldTranslate || ignoresKey(entry.key)) continue

    const source = sourceReference(entry, sourceLanguage)
    entries.push({
      entry,
      source,
      pairs: targets.map((language) => assessPair(entry, language, source.leaves)),
    })
  }

  return { catalog, sourceLanguage, targets, entries }
}

/** Every concrete string in a localization, substitution branches included. */
export function localizationLeaves(entry: CatalogEntry, language: LanguageCode): Leaf[] {
  const localization = entry.localizations[language]
  if (!localization) return []
  return [
    ...collectLeaves(localization),
    ...Object.values(localization.substitutions ?? {}).flatMap((s) => collectLeaves(s)),
  ]
}

function assessPair(
  entry: CatalogEntry,
  language: LanguageCode,
  sourceLeaves: Leaf[],
): PairAssessment {
  const localization = entry.localizations[language]
  if (!localization) {
    return { language, stateClass: 'missing', loc: entry.loc, complete: false, leaves: [] }
  }

  const direct = collectLeaves(localization)
  const all = localizationLeaves(entry, language)

  if (all.length === 0) {
    return { language, stateClass: 'missing', loc: localization.loc, complete: false, leaves: [] }
  }

  // Every branch the source defines must exist in the target. A German string
  // that covers `device.iphone` but not `device.ipad` is half-translated.
  const present = new Set(direct.map((leaf) => leafPathLabel(leaf.path)))
  const absent = sourceLeaves
    .map((leaf) => leafPathLabel(leaf.path))
    .filter((label) => label !== '' && !present.has(label))
  if (absent.length > 0) {
    return {
      language,
      stateClass: 'missing',
      detail: `missing ${absent.join(', ')}`,
      loc: localization.loc,
      complete: false,
      leaves: all,
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
  const complete = winner === undefined || (winner.class !== 'empty' && winner.class !== 'new')

  if (!winner) return { language, loc: localization.loc, complete, leaves: all }
  return {
    language,
    stateClass: winner.class,
    ...(winner.detail === undefined ? {} : { detail: winner.detail }),
    loc: winner.loc,
    complete,
    leaves: all,
  }
}

/**
 * Pick the source string a given target leaf should be compared against.
 *
 * Polish `few` has no English counterpart, but every branch of a plural group
 * carries the same arguments, so falling back to the source's `other` branch is
 * both safe and necessary to check expanded plurals at all.
 */
export function referenceLeafFor(
  sourceLeaves: Leaf[],
  targetPath: Leaf['path'],
): Leaf | undefined {
  const label = leafPathLabel(targetPath)
  const exact = sourceLeaves.find((leaf) => leafPathLabel(leaf.path) === label)
  if (exact) return exact

  const last = targetPath[targetPath.length - 1]
  if (last?.kind === 'plural') {
    const sibling = leafPathLabel([...targetPath.slice(0, -1), { kind: 'plural', branch: 'other' }])
    const match = sourceLeaves.find((leaf) => leafPathLabel(leaf.path) === sibling)
    if (match) return match
  }

  return sourceLeaves[0]
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
export function sourceReference(
  entry: CatalogEntry,
  sourceLanguage: LanguageCode,
): SourceReference {
  const localization = entry.localizations[sourceLanguage]
  if (localization) {
    const leaves = collectLeaves(localization)
    if (leaves.length > 0) {
      return {
        leaves,
        substitutions: localization.substitutions,
        reliable: true,
        explicit: true,
      }
    }
  }

  if (parseFormatSpecifiers(entry.key).length > 0) {
    return {
      leaves: [{ path: [], unit: { state: 'translated', value: entry.key }, loc: entry.loc }],
      substitutions: undefined,
      reliable: true,
      explicit: false,
    }
  }

  return { leaves: [], substitutions: undefined, reliable: false, explicit: false }
}

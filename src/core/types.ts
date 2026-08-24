/**
 * Domain model shared by the parsers, the analyzer and the reporters.
 *
 * Everything here is format-neutral: a `.xcstrings` String Catalog and a set of
 * legacy `.lproj/*.strings` tables both normalise into a `Catalog`, so the
 * analyzer never has to know which one it came from.
 */

/** A language identifier exactly as it appears in the catalog: `en`, `pt-BR`, `zh-Hans`. */
export type LanguageCode = string

/** Per-language translation state, as written by Xcode into a `stringUnit`. */
export type UnitState = 'translated' | 'new' | 'needs_review' | 'stale' | (string & {})

/**
 * Per-key extraction state, as written by Xcode at the top level of an entry.
 * `stale` is Xcode telling us it can no longer find the key in source code --
 * we take it at its word rather than re-deriving it by parsing Swift.
 */
export type ExtractionState =
  | 'manual'
  | 'migrated'
  | 'extracted_with_value'
  | 'stale'
  | (string & {})

export type VariationKind = 'plural' | 'device'

/** A point in a file, for annotations. Lines and columns are 1-based. */
export interface SourceLocation {
  /** Repo-relative POSIX path. */
  file: string
  line: number
  column?: number
}

export interface StringUnit {
  state: UnitState
  value: string
}

/**
 * A node that resolves to either one concrete string or a set of variation
 * branches. Variations nest (device -> plural is legal), so this is recursive.
 */
export interface ValueNode {
  unit?: StringUnit
  /**
   * Variation groups at this level. Xcode normally emits exactly one and nests
   * the rest inside its branches, but the format does not forbid siblings, so
   * this is a list -- dropping a second group would silently lose branches.
   */
  variations?: VariationNode[]
  loc: SourceLocation
}

export interface VariationNode {
  kind: VariationKind
  /** CLDR plural category (`one`, `few`, ...) or device class (`iphone`, ...) -> child. */
  branches: Record<string, ValueNode>
}

/**
 * A named substitution, referenced from the parent value as `%#@name@`.
 *
 * This is the String Catalog replacement for `.stringsdict` and is how Xcode
 * encodes a string with more than one independently-pluralising argument
 * ("%1$#@files@ in %2$#@folders@"). The plural branches live in here, not on
 * the localization, so plural coverage has to walk substitutions too.
 */
export interface Substitution extends ValueNode {
  argNum?: number
  /** The bare specifier this substitution stands in for, e.g. `lld`. */
  formatSpecifier?: string
}

export interface Localization extends ValueNode {
  substitutions?: Record<string, Substitution>
}

export interface CatalogEntry {
  key: string
  comment?: string
  /** Xcode's `shouldTranslate: false` means "never report this key". Defaults to true. */
  shouldTranslate: boolean
  extractionState?: ExtractionState
  localizations: Record<LanguageCode, Localization>
  /** Location of the key itself -- where an annotation about this key should point. */
  loc: SourceLocation
}

export type CatalogFormat = 'xcstrings' | 'strings' | 'stringsdict'

export interface Catalog {
  /**
   * Repo-relative POSIX path. For `.xcstrings` this is the file. For legacy
   * tables it is a synthetic path identifying the table, e.g.
   * `Sources/Resources/Localizable.strings`.
   */
  path: string
  format: CatalogFormat
  sourceLanguage: LanguageCode
  version?: string
  entries: CatalogEntry[]
  /** Every language that appears anywhere in this catalog, sorted. */
  languages: LanguageCode[]
}

/**
 * A file we could not parse. These are always fatal (exit 2): a `.xcstrings`
 * that is not valid JSON means something upstream is broken, and silently
 * reporting 100% coverage for it would be worse than stopping.
 */
export class CatalogParseError extends Error {
  readonly file: string
  readonly line?: number
  readonly column?: number

  constructor(file: string, message: string, line?: number, column?: number) {
    super(message)
    this.name = 'CatalogParseError'
    this.file = file
    this.line = line
    this.column = column
  }
}

export interface VariationStep {
  kind: VariationKind
  branch: string
}

/** One concrete string inside a value tree, addressed by its variation path. */
export interface Leaf {
  /** Empty for a plain `stringUnit`; else e.g. `[{device,iphone},{plural,one}]`. */
  path: VariationStep[]
  unit: StringUnit
  loc: SourceLocation
}

/* -------------------------------------------------------------------------- */
/* Issues                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Per-(key, language) translation states. These are mutually exclusive: a pair
 * is at most one of them, resolved by `STATE_PRECEDENCE`.
 */
export const STATE_ISSUE_CLASSES = ['missing', 'empty', 'new', 'needsReview', 'stale'] as const
export type StateIssueClass = (typeof STATE_ISSUE_CLASSES)[number]

/** Structural checks. Orthogonal to the state classes and to each other. */
export const STRUCTURAL_ISSUE_CLASSES = ['formatSpecifier', 'pluralCoverage'] as const
export type StructuralIssueClass = (typeof STRUCTURAL_ISSUE_CLASSES)[number]

export type IssueClass = StateIssueClass | StructuralIssueClass

export const ALL_ISSUE_CLASSES: readonly IssueClass[] = [
  ...STATE_ISSUE_CLASSES,
  ...STRUCTURAL_ISSUE_CLASSES,
]

/**
 * Order in which state classes win when a pair qualifies for several -- a unit
 * with `state: "new"` and `value: ""` is both `new` and `empty`. Reporting it
 * twice would triple-count the same miss and make the totals lie.
 */
export const STATE_PRECEDENCE: readonly StateIssueClass[] = [
  'missing',
  'empty',
  'new',
  'needsReview',
  'stale',
]

export type Severity = 'error' | 'warn' | 'off'
export type ReportedSeverity = 'error' | 'warn'

export interface Issue {
  class: IssueClass
  severity: ReportedSeverity
  /** Catalog path this came from. */
  catalog: string
  key: string
  /**
   * Undefined for key-scoped issues -- a `stale` key is dead in every language
   * at once, and fanning it out across 30 locales would bury everything else.
   */
  language?: LanguageCode
  /** Where an annotation about this issue should point. */
  loc: SourceLocation
  /** One line, shown in annotations and tables. */
  message: string
  /** Optional extra context for the summary; never shown in an annotation. */
  detail?: string
}

export interface LanguageCoverage {
  language: LanguageCode
  /** Keys in scope for this language: translatable, not ignored. */
  translatable: number
  /** Of those, how many have a complete, non-empty translation. */
  translated: number
  /** 0-100, rounded to one decimal. 100 when there is nothing to translate. */
  percent: number
}

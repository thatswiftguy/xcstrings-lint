/**
 * CLDR cardinal plural categories, as a static table.
 *
 * A translation that only supplies `one` and `other` is grammatically wrong in
 * Polish (which needs `few` and `many`) and redundant in Japanese (which needs
 * only `other`). Xcode's String Catalog editor shows exactly these categories
 * per language, so this table is what makes our plural check agree with what a
 * developer sees in Xcode.
 *
 * Deliberately hand-maintained rather than pulled from a package: it is ~60
 * lines of data that changes roughly never, and a CLDR dependency would be
 * megabytes in the ncc bundle for this one lookup.
 */

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

export const ALL_PLURAL_CATEGORIES: readonly PluralCategory[] = [
  'zero',
  'one',
  'two',
  'few',
  'many',
  'other',
]

/** Every language shares `other`; the sets below list the full requirement. */
const CATEGORY_SETS: Array<{
  categories: readonly PluralCategory[]
  languages: readonly string[]
}> = [
  {
    categories: ['other'],
    languages: [
      'bo', 'dz', 'id', 'ig', 'ii', 'ja', 'jbo', 'jv', 'jw', 'kde', 'kea', 'km',
      'ko', 'lkt', 'lo', 'ms', 'my', 'nqo', 'root', 'sah', 'ses', 'sg', 'su',
      'th', 'to', 'vi', 'wo', 'yo', 'yue', 'zh',
    ],
  },
  {
    categories: ['one', 'other'],
    languages: [
      'af', 'am', 'an', 'as', 'ast', 'az', 'bg', 'bn', 'brx', 'ce', 'chr',
      'ckb', 'da', 'de', 'dv', 'ee', 'el', 'en', 'eo', 'et', 'eu', 'fa', 'fi',
      'fil', 'fo', 'fur', 'fy', 'gsw', 'gu', 'ha', 'haw', 'hi', 'hu', 'hy',
      'ia', 'io', 'is', 'jgo', 'jmc', 'ka', 'kaj', 'kcg', 'kk', 'kkj', 'kl',
      'kn', 'ks', 'ksb', 'ku', 'ky', 'lb', 'lg', 'mas', 'mgo', 'ml', 'mn',
      'mr', 'nah', 'nb', 'nd', 'ne', 'nl', 'nn', 'nnh', 'no', 'nr', 'ny',
      'nyn', 'om', 'or', 'os', 'pa', 'pap', 'ps', 'rm', 'rof', 'rwk', 'saq',
      'sd', 'sdh', 'seh', 'sn', 'so', 'sq', 'ss', 'ssy', 'st', 'sv', 'sw',
      'syr', 'ta', 'te', 'teo', 'tig', 'tk', 'tn', 'tr', 'ts', 'ug', 'ur',
      'uz', 've', 'vo', 'vun', 'wae', 'xh', 'xog', 'yi', 'zu',
    ],
  },
  {
    // CLDR added `many` for the Romance languages to cover compact forms such
    // as "1 million". Xcode surfaces it, so we do too -- as a warning.
    categories: ['one', 'many', 'other'],
    languages: ['ca', 'es', 'fr', 'it', 'pt'],
  },
  {
    categories: ['one', 'two', 'other'],
    languages: ['he', 'iw'],
  },
  {
    categories: ['zero', 'one', 'other'],
    languages: ['lv', 'prg'],
  },
  {
    categories: ['one', 'few', 'other'],
    languages: ['bs', 'hr', 'mo', 'ro', 'sh', 'sr'],
  },
  {
    categories: ['one', 'few', 'many', 'other'],
    languages: ['be', 'cs', 'lt', 'pl', 'ru', 'sk', 'uk'],
  },
  {
    categories: ['one', 'two', 'few', 'other'],
    languages: ['dsb', 'gd', 'hsb', 'sl'],
  },
  {
    categories: ['one', 'two', 'few', 'many', 'other'],
    languages: ['br', 'ga', 'mt'],
  },
  {
    categories: ['zero', 'one', 'two', 'few', 'many', 'other'],
    languages: ['ar', 'ars', 'cy', 'kw'],
  },
]

const TABLE = new Map<string, readonly PluralCategory[]>()
for (const { categories, languages } of CATEGORY_SETS) {
  for (const language of languages) TABLE.set(language, categories)
}

/**
 * Overrides for locales whose plural rules differ from their base language.
 * Empty today -- every region variant Xcode emits (`pt-BR`, `pt-PT`, `zh-Hans`,
 * `es-419`, `en-GB`, `fr-CA`) shares its base language's categories -- but the
 * hook is here so a future divergence is a one-line change.
 */
const LOCALE_OVERRIDES = new Map<string, readonly PluralCategory[]>()

/** `pt-BR` -> `pt`, `zh_Hans` -> `zh`. */
export function baseLanguage(locale: string): string {
  return (locale.split(/[-_]/)[0] ?? locale).toLowerCase()
}

export interface PluralRequirement {
  categories: readonly PluralCategory[]
  /**
   * False when the locale is not in the table and we fell back to `one`/`other`.
   * Callers downgrade unknown locales rather than reporting a guess as fact.
   */
  known: boolean
}

export function requiredPluralCategories(locale: string): PluralRequirement {
  const normalized = locale.replace(/_/g, '-')
  const override = LOCALE_OVERRIDES.get(normalized) ?? LOCALE_OVERRIDES.get(normalized.toLowerCase())
  if (override) return { categories: override, known: true }

  const categories = TABLE.get(baseLanguage(locale))
  if (categories) return { categories, known: true }

  return { categories: ['one', 'other'], known: false }
}

/**
 * Categories required but not supplied. `other` is always required; extra
 * categories beyond the requirement are harmless and never reported.
 */
export function missingPluralCategories(
  locale: string,
  supplied: Iterable<string>,
): { missing: PluralCategory[]; known: boolean } {
  const { categories, known } = requiredPluralCategories(locale)
  const have = new Set(supplied)
  return { missing: categories.filter((category) => !have.has(category)), known }
}

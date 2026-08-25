import type { CatalogEntry, CatalogFormat, LanguageCode } from '../types.js'
import type { Rule } from './rule.js'

/**
 * A key that exists only in translations.
 *
 * Somebody deleted the English string and left eight locales holding a
 * translation of it, or renamed a key in the source table and not in the
 * others. Either way the key can never be looked up at runtime, and every
 * translator who touches the file will translate it again.
 *
 * The two formats need different evidence, because "no source-language entry"
 * means different things in each:
 *
 * - **Legacy tables** declare every key explicitly in every `.lproj` file, so a
 *   key absent from the source language's file is unambiguous.
 * - **String Catalogs** routinely have no source-language block at all, because
 *   with literal keys the key *is* the English text. Reporting those would mean
 *   flagging every well-formed catalog in the world, so the check only fires
 *   for keys that clearly are not source text themselves.
 */
export const orphanKeyRule: Rule = {
  name: 'orphan-keys',
  classes: ['orphanKey'],

  run({ assessment, report }) {
    const { sourceLanguage, catalog } = assessment

    for (const { entry, source } of assessment.entries) {
      if (source.explicit) continue
      // Xcode has already told us this key is dead; the `stale` check reports
      // it, and saying it twice in different words helps nobody.
      if (entry.extractionState === 'stale') continue
      if (!looksLikeAnIdentifier(entry, catalog.format)) continue

      const translated = translatedLanguages(entry, sourceLanguage)
      if (translated.length === 0) continue

      report({
        class: 'orphanKey',
        key: entry.key,
        loc: entry.loc,
        message:
          `"${entry.key}" has no ${sourceLanguage} source string, ` +
          `but is translated into ${translated.join(', ')}`,
        detail: 'the source string was probably renamed or deleted',
      })
    }
  },
}

function translatedLanguages(entry: CatalogEntry, sourceLanguage: LanguageCode): LanguageCode[] {
  return Object.keys(entry.localizations)
    .filter((language) => language !== sourceLanguage)
    .sort()
}

/**
 * Whether the key is an identifier rather than the source string itself.
 *
 * `payment_cvv_hint` is an identifier and needs an English string somewhere.
 * `"You have %lld unread"` is the English string, and asking for another copy
 * of it would be nonsense.
 */
function looksLikeAnIdentifier(entry: CatalogEntry, format: CatalogFormat): boolean {
  if (format !== 'xcstrings') return true
  // Xcode writes this state when it pulled the key straight out of source code
  // with the key as its value, which settles the question outright.
  if (entry.extractionState === 'extracted_with_value') return false
  return !/\s/.test(entry.key)
}

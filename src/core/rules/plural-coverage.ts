import { missingPluralCategories } from '../cldr-plurals.js'
import { findVariationGroups, leafPathLabel } from '../parse/value-node.js'
import type { Localization } from '../types.js'
import type { Rule } from './rule.js'

/**
 * CLDR plural categories, per language.
 *
 * Polish needs `one/few/many/other`; a translation that supplies only
 * `one/other` is grammatically wrong for most numbers. Japanese needs only
 * `other`. This runs against the source language too -- an English plural that
 * forgot `one` is just as broken as a Polish one that forgot `few`.
 */
export const pluralCoverageRule: Rule = {
  name: 'plural-coverage',
  classes: ['pluralCoverage'],

  run({ assessment, report }) {
    const languages = [...assessment.targets, assessment.sourceLanguage]

    for (const { entry } of assessment.entries) {
      for (const language of languages) {
        const localization = entry.localizations[language]
        if (!localization) continue

        for (const found of pluralGroups(localization)) {
          const supplied = Object.keys(found.group.branches)
          const { missing, known } = missingPluralCategories(language, supplied)
          // Never report against a locale we have no CLDR data for: the
          // one/other fallback is a guess, and a guessed complaint is worse
          // than silence.
          if (!known || missing.length === 0) continue

          const where = found.path.length > 0 ? ` [${leafPathLabel(found.path)}]` : ''
          report({
            class: 'pluralCoverage',
            key: entry.key,
            language,
            loc: found.loc,
            message: `${language}${where} is missing the ${missing.join(', ')} plural ${
              missing.length === 1 ? 'category' : 'categories'
            }`,
            detail: `has ${supplied.sort().join(', ')}`,
          })
        }
      }
    }
  },
}

/**
 * Plural groups on the localization itself and inside every substitution.
 *
 * A String Catalog puts the plural branches of a multi-argument string in the
 * substitution table rather than on the localization, so a walk that skipped
 * substitutions would find nothing in exactly the strings most likely to be
 * wrong.
 */
function pluralGroups(localization: Localization) {
  return [
    ...findVariationGroups(localization, 'plural'),
    ...Object.values(localization.substitutions ?? {}).flatMap((s) =>
      findVariationGroups(s, 'plural'),
    ),
  ]
}

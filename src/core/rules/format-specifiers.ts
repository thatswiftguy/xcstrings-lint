import { referenceLeafFor } from '../assess.js'
import { compareFormatSpecifiers } from '../parse/format-specifiers.js'
import { leafPathLabel } from '../parse/value-node.js'
import type { Rule } from './rule.js'

/**
 * The highest-value check in the tool.
 *
 * A missing translation shows the wrong language. A specifier mismatch between
 * `"You have %lld items"` and `"Sie haben %@ Artikel"` reads a 64-bit integer
 * as an object pointer and crashes at runtime.
 */
export const formatSpecifierRule: Rule = {
  name: 'format-specifiers',
  classes: ['formatSpecifier'],

  run({ assessment, report }) {
    for (const { entry, source, pairs } of assessment.entries) {
      // Without a source string there is nothing to compare against, and
      // guessing one invents a mismatch for every key that is an identifier
      // rather than a sentence.
      if (!source.reliable) continue

      for (const pair of pairs) {
        const substitutions = entry.localizations[pair.language]?.substitutions

        for (const leaf of pair.leaves) {
          if (leaf.unit.value === '') continue
          const reference = referenceLeafFor(source.leaves, leaf.path)
          if (!reference) continue

          const mismatches = compareFormatSpecifiers(reference.unit.value, leaf.unit.value, {
            sourceSubstitutions: source.substitutions,
            targetSubstitutions: substitutions,
          })

          for (const mismatch of mismatches) {
            const where = leaf.path.length > 0 ? ` [${leafPathLabel(leaf.path)}]` : ''
            report({
              class: 'formatSpecifier',
              key: entry.key,
              language: pair.language,
              loc: leaf.loc,
              message: `${pair.language}${where}: ${mismatch.message}`,
              detail: `source: ${reference.unit.value}`,
              // A width change is a bug but not a crash, so it never escalates
              // past a warning even when formatSpecifiers is set to error.
              ...(mismatch.severity === 'warn' ? { forceWarn: true } : {}),
            })
          }
        }
      }
    }
  },
}

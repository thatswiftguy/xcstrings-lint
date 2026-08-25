import { referenceLeafFor } from '../assess.js'
import { leafPathLabel } from '../parse/value-node.js'
import type { Rule } from './rule.js'

/**
 * A translation byte-identical to the source string.
 *
 * Usually a placeholder somebody pasted and never came back to: the state says
 * `translated`, the coverage figure says 100%, and the app ships English to
 * German users. Xcode cannot tell the difference either.
 *
 * Off by default, and deliberately so. "Cancel", "OK", "Email", "Wi-Fi" and
 * every product name in the catalog are legitimately identical in a dozen
 * languages, and a check that fires on those is a check people switch off
 * within a day. Projects that keep their proper nouns in `ignore.keys` get real
 * value from turning it on; the rest should not have it forced on them.
 */
export const identicalToSourceRule: Rule = {
  name: 'identical-to-source',
  classes: ['identicalToSource'],

  run({ assessment, report }) {
    for (const { entry, source, pairs } of assessment.entries) {
      // Comparing against a key that only looks like a source string would
      // flag every literal-key catalog in its entirety.
      if (!source.explicit) continue

      for (const pair of pairs) {
        // Nothing to compare: the assessment already reported it as absent.
        if (pair.stateClass === 'missing') continue

        for (const leaf of pair.leaves) {
          if (leaf.unit.value === '') continue
          const reference = referenceLeafFor(source.leaves, leaf.path)
          if (!reference || reference.unit.value !== leaf.unit.value) continue

          const where = leaf.path.length > 0 ? ` [${leafPathLabel(leaf.path)}]` : ''
          report({
            class: 'identicalToSource',
            key: entry.key,
            language: pair.language,
            loc: leaf.loc,
            message: `${pair.language}${where} is identical to the ${assessment.sourceLanguage} source string`,
            detail: `both say ${JSON.stringify(leaf.unit.value)}`,
          })
        }
      }
    }
  },
}

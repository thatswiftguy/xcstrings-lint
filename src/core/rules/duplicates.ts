import { leafPathLabel } from '../parse/value-node.js'
import type { Leaf } from '../types.js'
import type { Rule } from './rule.js'

/**
 * The same key declared twice in one file.
 *
 * Both formats resolve this silently -- JSON is last-wins and so is a legacy
 * table -- which is precisely what makes it worth reporting. Whatever the first
 * declaration said has already been discarded, and nothing in Xcode will tell
 * you. It usually happens on a bad merge, and the string that lost is normally
 * the one somebody just translated.
 */
export const duplicateKeyRule: Rule = {
  name: 'duplicate-keys',
  classes: ['duplicateKey'],

  run({ assessment, ignoresKey, report }) {
    for (const duplicate of assessment.catalog.duplicateKeys) {
      if (ignoresKey(duplicate.key)) continue

      const where = duplicate.language ? `${duplicate.language}: ` : ''
      report({
        class: 'duplicateKey',
        key: duplicate.key,
        ...(duplicate.language === undefined ? {} : { language: duplicate.language }),
        loc: duplicate.loc,
        message:
          `${where}"${duplicate.key}" is declared more than once; ` +
          `the declaration on line ${duplicate.firstLoc.line} is silently discarded`,
        detail: `first declared at ${duplicate.firstLoc.file}:${duplicate.firstLoc.line}`,
      })
    }
  },
}

/**
 * Two different keys with the same source string.
 *
 * Almost always a copy-paste that should have been one key, and it costs real
 * money: every duplicate is paid for and reviewed twice in every language. It
 * is a warning rather than an error because the same English word genuinely
 * does need two keys sometimes -- "Order" the noun and "Order" the verb
 * translate differently -- and only the person who wrote it can tell.
 */
export const duplicateValueRule: Rule = {
  name: 'duplicate-values',
  classes: ['duplicateValue'],

  run({ assessment, report }) {
    const seen = new Map<string, { key: string; line: number }>()

    for (const { entry, source } of assessment.entries) {
      // Only compare real source strings. When the key *is* the source text,
      // two distinct keys are two distinct strings by definition.
      if (!source.explicit) continue

      const signature = valueSignature(source.leaves)
      if (signature === undefined) continue

      const first = seen.get(signature)
      if (!first) {
        seen.set(signature, { key: entry.key, line: entry.loc.line })
        continue
      }

      report({
        class: 'duplicateValue',
        key: entry.key,
        loc: entry.loc,
        message: `"${entry.key}" has the same source text as "${first.key}"`,
        detail: `${preview(source.leaves)} — also on line ${first.line}`,
      })
    }
  },
}

/**
 * A stable identity for what an entry says in the source language.
 *
 * Path-qualified so a plural is only equal to a plural that says the same thing
 * in every branch, and sorted so branch order cannot make two identical
 * entries look different. Undefined when there is nothing worth comparing.
 */
function valueSignature(leaves: Leaf[]): string | undefined {
  const parts = leaves
    .filter((leaf) => leaf.unit.value !== '')
    .map((leaf) => [leafPathLabel(leaf.path), leaf.unit.value])
    .sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''))
  // JSON-encoded so no branch label can run into the value beside it and make
  // two different entries collide on one signature.
  return parts.length === 0 ? undefined : JSON.stringify(parts)
}

const MAX_PREVIEW = 60

function preview(leaves: Leaf[]): string {
  const value = leaves.find((leaf) => leaf.unit.value !== '')?.unit.value ?? ''
  const single = value.replace(/\s+/g, ' ').trim()
  return single.length > MAX_PREVIEW ? `"${single.slice(0, MAX_PREVIEW - 1)}…"` : `"${single}"`
}

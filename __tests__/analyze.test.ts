import { describe, expect, it } from 'vitest'
import { analyze } from '../src/core/analyze.js'
import { defaultConfig, parseConfig, type ResolvedConfig } from '../src/core/config.js'
import { parseXcstrings } from '../src/core/parse-xcstrings.js'
import type { Issue } from '../src/core/types.js'
import { loadFixture } from './helpers.js'

const catalog = (name: string) => parseXcstrings(`App/${name}`, loadFixture('xcstrings', name))

const run = (name: string, config: ResolvedConfig = defaultConfig()) =>
  analyze([catalog(name)], config)

const find = (issues: Issue[], key: string, language?: string) =>
  issues.filter((i) => i.key === key && (language === undefined || i.language === language))

describe('issue classification', () => {
  const { issues } = run('issues.xcstrings')
  const classOf = (key: string, language: string) => find(issues, key, language)[0]?.class

  it('says nothing about a fully translated key', () => {
    expect(find(issues, 'all.good')).toEqual([])
  })

  it('reports an absent language as missing', () => {
    expect(classOf('de.absent', 'de')).toBe('missing')
    expect(find(issues, 'de.absent', 'fr')).toEqual([])
  })

  it('separates an empty value from a missing one', () => {
    expect(classOf('de.blank', 'de')).toBe('empty')
  })

  it('reports an untouched extraction as new, not as translated', () => {
    expect(classOf('de.untouched', 'de')).toBe('new')
  })

  it('reports needs_review as its own class', () => {
    expect(classOf('de.unsure', 'de')).toBe('needsReview')
  })

  it('reports a stale key once, not once per language', () => {
    const stale = issues.filter((i) => i.class === 'stale')
    expect(stale).toHaveLength(1)
    expect(stale[0]!.key).toBe('gone.from.source')
    expect(stale[0]!.language).toBeUndefined()
    expect(stale[0]!.message).toMatch(/no longer referenced in source/)
  })

  it('treats a half-covered variation tree as missing, naming the branch', () => {
    const issue = find(issues, 'half.a.device.tree', 'de')[0]!
    expect(issue.class).toBe('missing')
    expect(issue.detail).toBe('missing device.ipad')
    expect(find(issues, 'half.a.device.tree', 'fr')).toEqual([])
  })

  it('reports a key that is both new and empty exactly once', () => {
    const both = find(issues, 'both.new.and.blank', 'de')
    expect(both).toHaveLength(1)
    expect(both[0]!.class).toBe('empty')
  })

  it('never reports a shouldTranslate: false key', () => {
    expect(find(issues, 'skip.me')).toEqual([])
  })
})

describe('severity mapping', () => {
  it('applies the configured severity per class', () => {
    const { issues } = run('issues.xcstrings')
    const severityOf = (cls: string) => issues.find((i) => i.class === cls)?.severity
    expect(severityOf('missing')).toBe('error')
    expect(severityOf('empty')).toBe('error')
    expect(severityOf('new')).toBe('error')
    expect(severityOf('needsReview')).toBe('warn')
    expect(severityOf('stale')).toBe('warn')
  })

  it('drops classes switched off', () => {
    const { issues } = run('issues.xcstrings', parseConfig('failOn: [missing]\nwarnOn: []'))
    expect([...new Set(issues.map((i) => i.class))].sort()).toEqual(['missing'])
  })

  it('sorts errors before warnings', () => {
    const { issues } = run('issues.xcstrings')
    const firstWarn = issues.findIndex((i) => i.severity === 'warn')
    const lastError = issues.map((i) => i.severity).lastIndexOf('error')
    expect(firstWarn).toBeGreaterThan(lastError)
  })
})

describe('ignore rules', () => {
  it('skips exact keys and glob patterns', () => {
    const config = parseConfig("ignore:\n  keys: ['de.absent']\n  patterns: ['debug_*']")
    const { issues } = run('issues.xcstrings', config)
    expect(find(issues, 'de.absent')).toEqual([])
    expect(find(issues, 'debug_reset_state')).toEqual([])
    expect(find(issues, 'de.blank').length).toBeGreaterThan(0)
  })

  it('skips whole files', () => {
    const config = parseConfig("ignore:\n  files: ['App/**']")
    const result = run('issues.xcstrings', config)
    expect(result.issues).toEqual([])
    expect(result.catalogs).toEqual([])
  })
})

describe('required languages', () => {
  it('gates only the listed languages', () => {
    const { issues, languages } = run('issues.xcstrings', parseConfig('required: [fr]'))
    expect(languages).toEqual(['fr'])
    expect(issues.some((i) => i.language === 'de')).toBe(false)
  })

  it('reports every key missing for a language that does not exist yet', () => {
    const { issues, coverage } = run('issues.xcstrings', parseConfig('required: [ja]'))
    const missing = issues.filter((i) => i.class === 'missing' && i.language === 'ja')
    expect(missing).toHaveLength(coverage.ja!.translatable)
    expect(coverage.ja!.percent).toBe(0)
  })
})

describe('coverage', () => {
  const { coverage } = run('issues.xcstrings')

  it('excludes the source language', () => {
    expect(coverage.en).toBeUndefined()
  })

  it('excludes untranslatable and ignored keys from the denominator', () => {
    // 10 entries, minus shouldTranslate:false -> 9 in scope.
    expect(coverage.de!.translatable).toBe(9)
  })

  it('counts needs_review as translated but new and empty as not', () => {
    // de is short on de.absent, de.blank, de.untouched, half.a.device.tree,
    // both.new.and.blank and debug_reset_state. That leaves all.good,
    // de.unsure (needs_review, still counted) and gone.from.source -> 3 of 9.
    expect(coverage.de!.translated).toBe(3)
    expect(coverage.de!.percent).toBe(33.3)
  })

  it('is 100 percent when nothing is outstanding', () => {
    expect(run('complete.xcstrings').coverage.de!.percent).toBe(100)
  })
})

describe('format specifiers', () => {
  const { issues } = run('specifiers.xcstrings')
  const format = issues.filter((i) => i.class === 'formatSpecifier')

  it('errors when an object replaces an integer', () => {
    const issue = find(format, 'crash.object.for.int')[0]!
    expect(issue.severity).toBe('error')
    expect(issue.message).toBe('de: expected %lld at position 1, found %@')
    expect(issue.detail).toBe('source: You have %lld items')
  })

  it('only warns on a width change, even though the class is set to error', () => {
    const issue = find(format, 'width.only')[0]!
    expect(issue.severity).toBe('warn')
    expect(issue.message).toMatch(/same type, different width/)
  })

  it('accepts a legitimate reordering', () => {
    expect(find(format, 'reordered.positional')).toEqual([])
  })

  it('reports each dropped specifier', () => {
    expect(find(format, 'dropped.both')).toHaveLength(2)
  })

  it('ignores escaped percents', () => {
    expect(find(format, 'escaped.percent')).toEqual([])
  })

  it('uses the key as the source when the key is itself a format string', () => {
    const issue = find(format, 'You have %lld unread')[0]!
    expect(issue.severity).toBe('error')
    expect(issue.message).toMatch(/expected %lld at position 1, found %@/)
  })

  it('stays silent for a semantic key with no source string to compare against', () => {
    // `payment_count` has no `en` entry and is an identifier, not a format
    // string. Comparing against it would invent a mismatch for every language.
    expect(find(format, 'payment_count')).toEqual([])
  })

  it('can be switched off', () => {
    const { issues: none } = run('specifiers.xcstrings', parseConfig('formatSpecifiers: off'))
    expect(none.some((i) => i.class === 'formatSpecifier')).toBe(false)
  })
})

describe('plural coverage', () => {
  const { issues } = run('plurals.xcstrings')
  const plural = issues.filter((i) => i.class === 'pluralCoverage')

  it('reports the categories Polish is short of', () => {
    const issue = plural.find((i) => i.key === 'message.count' && i.language === 'pl')!
    expect(issue.severity).toBe('warn')
    expect(issue.message).toBe('pl is missing the few, many plural categories')
    expect(issue.detail).toBe('has one, other')
  })

  it('accepts Japanese supplying only other', () => {
    expect(plural.some((i) => i.language === 'ja')).toBe(false)
  })

  it('accepts a complete English plural', () => {
    expect(plural.some((i) => i.key === 'message.count' && i.language === 'en')).toBe(false)
  })

  it('looks inside substitutions', () => {
    const issue = plural.find((i) => i.key === 'file.count' && i.language === 'pl')!
    expect(issue).toBeDefined()
    expect(issue.message).toMatch(/missing the few, many plural categories/)
  })

  it('can be escalated to an error', () => {
    const { issues: strict } = run('plurals.xcstrings', parseConfig('pluralCoverage: error'))
    expect(strict.find((i) => i.class === 'pluralCoverage')!.severity).toBe('error')
  })
})

describe('annotations have somewhere to point', () => {
  it('gives every issue a real line inside its own file', () => {
    for (const name of ['issues.xcstrings', 'specifiers.xcstrings', 'plurals.xcstrings']) {
      const { issues } = run(name)
      expect(issues.length).toBeGreaterThan(0)
      for (const issue of issues) {
        expect(issue.loc.file).toBe(`App/${name}`)
        expect(issue.loc.line).toBeGreaterThan(1)
      }
    }
  })
})

describe('multiple catalogs', () => {
  it('pools languages across catalogs and keeps issues attributed to their file', () => {
    const result = analyze(
      [catalog('issues.xcstrings'), catalog('plurals.xcstrings')],
      defaultConfig(),
    )
    expect(result.languages).toEqual(['de', 'fr', 'ja', 'pl'])
    // plurals.xcstrings has no `de`, so pooling surfaces that gap.
    expect(
      result.issues.some((i) => i.catalog === 'App/plurals.xcstrings' && i.language === 'de'),
    ).toBe(true)
  })
})

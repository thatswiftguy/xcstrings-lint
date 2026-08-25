import { describe, expect, it } from 'vitest'
import { analyze } from '../src/core/analyze.js'
import { parseConfig } from '../src/core/config.js'
import { assembleLegacyCatalogs } from '../src/core/parse/strings.js'
import { parseXcstrings } from '../src/core/parse/xcstrings.js'
import type { Catalog, Issue } from '../src/core/types.js'

/** The catalog-hygiene checks: duplicates, orphans and untouched translations. */

const unit = (value: string, state = 'translated') => ({ stringUnit: { state, value } })

const xcstrings = (strings: Record<string, unknown>, sourceLanguage = 'en'): Catalog =>
  parseXcstrings('App/L.xcstrings', JSON.stringify({ sourceLanguage, strings }))

const legacy = (files: Record<string, string>): Catalog[] =>
  assembleLegacyCatalogs(
    Object.entries(files).map(([path, text]) => ({ path, buffer: Buffer.from(text, 'utf8') })),
  )

const issuesOf = (catalogs: Catalog[], yaml = ''): Issue[] =>
  analyze(catalogs, parseConfig(yaml)).issues

const classesOf = (catalogs: Catalog[], yaml = ''): string[] =>
  issuesOf(catalogs, yaml).map((issue) => issue.class)

describe('duplicate keys', () => {
  const duplicated = `{"sourceLanguage":"en","strings":{
    "app.title":{"localizations":{"en":{"stringUnit":{"state":"translated","value":"First"}},"de":{"stringUnit":{"state":"translated","value":"Erst"}}}},
    "other":{"localizations":{"en":{"stringUnit":{"state":"translated","value":"X"}},"de":{"stringUnit":{"state":"translated","value":"Ix"}}}},
    "app.title":{"localizations":{"en":{"stringUnit":{"state":"translated","value":"Second"}},"de":{"stringUnit":{"state":"translated","value":"Zweit"}}}}
  }}`

  it('collapses the redeclaration into one entry, JSON last-wins', () => {
    const catalog = parseXcstrings('App/L.xcstrings', duplicated)
    expect(catalog.entries.map((e) => e.key)).toEqual(['app.title', 'other'])
    const title = catalog.entries.find((e) => e.key === 'app.title')!
    expect(title.localizations.en!.unit!.value).toBe('Second')
  })

  it('records where both declarations are', () => {
    const catalog = parseXcstrings('App/L.xcstrings', duplicated)
    expect(catalog.duplicateKeys).toHaveLength(1)
    const [duplicate] = catalog.duplicateKeys
    expect(duplicate!.key).toBe('app.title')
    expect(duplicate!.firstLoc.line).toBeLessThan(duplicate!.loc.line)
  })

  it('reports it as an error, naming the line that is discarded', () => {
    const [issue] = issuesOf([parseXcstrings('App/L.xcstrings', duplicated)])
    expect(issue!.class).toBe('duplicateKey')
    expect(issue!.severity).toBe('error')
    expect(issue!.message).toMatch(/declared more than once/)
    expect(issue!.message).toMatch(/silently discarded/)
  })

  it('says nothing about a well-formed catalog', () => {
    const clean = xcstrings({ a: { localizations: { en: unit('A'), de: unit('Ah') } } })
    expect(clean.duplicateKeys).toEqual([])
    expect(classesOf([clean])).toEqual([])
  })

  it('finds a key declared twice in one legacy table', () => {
    const catalogs = legacy({
      'App/en.lproj/L.strings': '"a" = "One";\n"a" = "Two";\n"b" = "B";\n',
      'App/de.lproj/L.strings': '"a" = "Eins";\n"b" = "Be";\n',
    })
    const duplicates = catalogs[0]!.duplicateKeys
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0]).toMatchObject({ key: 'a', language: 'en' })
    expect(classesOf(catalogs)).toContain('duplicateKey')
  })

  it('does not call a stringsdict plural form a duplicate of its strings entry', () => {
    // The two files together are the documented way to give a key plural
    // forms, not a mistake.
    const catalogs = legacy({
      'App/en.lproj/L.strings': '"count" = "%lld items";\n',
      'App/en.lproj/L.stringsdict': `<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>count</key>
  <dict>
    <key>NSStringLocalizedFormatKey</key><string>%#@n@</string>
    <key>n</key>
    <dict>
      <key>NSStringFormatValueTypeKey</key><string>lld</string>
      <key>one</key><string>%lld item</string>
      <key>other</key><string>%lld items</string>
    </dict>
  </dict>
</dict></plist>`,
    })
    expect(catalogs[0]!.duplicateKeys).toEqual([])
  })

  it('can be switched off', () => {
    const catalog = parseXcstrings('App/L.xcstrings', duplicated)
    expect(classesOf([catalog], 'duplicateKeys: off')).not.toContain('duplicateKey')
  })
})

describe('duplicate source strings', () => {
  const catalog = xcstrings({
    cart_title: { localizations: { en: unit('Basket'), de: unit('Korb') } },
    checkout_title: { localizations: { en: unit('Basket'), de: unit('Korb') } },
    other: { localizations: { en: unit('Pay'), de: unit('Zahlen') } },
  })

  it('names the key it collides with, and reports it once', () => {
    const found = issuesOf([catalog]).filter((i) => i.class === 'duplicateValue')
    expect(found).toHaveLength(1)
    expect(found[0]!.key).toBe('checkout_title')
    expect(found[0]!.message).toContain('cart_title')
    expect(found[0]!.severity).toBe('warn')
  })

  it('quotes the shared text so the report is actionable', () => {
    const found = issuesOf([catalog]).find((i) => i.class === 'duplicateValue')!
    expect(found.detail).toContain('"Basket"')
  })

  it('ignores empty source strings', () => {
    const blanks = xcstrings({
      a: { localizations: { en: unit(''), de: unit('Ah') } },
      b: { localizations: { en: unit(''), de: unit('Be') } },
    })
    expect(classesOf([blanks])).not.toContain('duplicateValue')
  })

  it('never fires when the key is the source string', () => {
    // Two distinct keys are two distinct strings by definition.
    const literal = xcstrings({
      Basket: { localizations: { de: unit('Korb') } },
      Cart: { localizations: { de: unit('Korb') } },
    })
    expect(classesOf([literal])).not.toContain('duplicateValue')
  })

  it('compares plural branches as a whole', () => {
    const plurals = (one: string) => ({
      localizations: {
        en: { variations: { plural: { one: unit(one), other: unit('%lld items') } } },
        de: { variations: { plural: { one: unit('x'), other: unit('y') } } },
      },
    })
    const same = xcstrings({ a: plurals('%lld item'), b: plurals('%lld item') })
    const different = xcstrings({ a: plurals('%lld item'), b: plurals('%lld thing') })
    expect(classesOf([same])).toContain('duplicateValue')
    expect(classesOf([different])).not.toContain('duplicateValue')
  })

  it('can be escalated to an error', () => {
    const found = issuesOf([catalog], 'duplicateValues: error').find(
      (i) => i.class === 'duplicateValue',
    )!
    expect(found.severity).toBe('error')
  })
})

describe('orphan keys', () => {
  it('reports a key that only exists in translations', () => {
    const catalog = xcstrings({
      dropped: { extractionState: 'manual', localizations: { de: unit('Verwaist') } },
    })
    const found = issuesOf([catalog]).filter((i) => i.class === 'orphanKey')
    expect(found).toHaveLength(1)
    expect(found[0]!.severity).toBe('warn')
    expect(found[0]!.message).toContain('no en source string')
    expect(found[0]!.message).toContain('de')
  })

  it('leaves a literal-text key alone', () => {
    // With literal keys the key *is* the English string, so there is no
    // separate source entry to be missing.
    const catalog = xcstrings({
      'You have %lld unread': {
        extractionState: 'extracted_with_value',
        localizations: { de: unit('%lld ungelesen') },
      },
      'Save card': { localizations: { de: unit('Karte sichern') } },
    })
    expect(classesOf([catalog])).not.toContain('orphanKey')
  })

  it('does not pile on top of a key Xcode already called stale', () => {
    const catalog = xcstrings({
      gone: { extractionState: 'stale', localizations: { de: unit('Weg') } },
    })
    const classes = classesOf([catalog])
    expect(classes).toContain('stale')
    expect(classes).not.toContain('orphanKey')
  })

  it('says nothing about a key with a source string', () => {
    const catalog = xcstrings({ a: { localizations: { en: unit('A'), de: unit('Ah') } } })
    expect(classesOf([catalog])).not.toContain('orphanKey')
  })

  it('reports a legacy key missing from the source table, spaces and all', () => {
    // Every legacy key is declared explicitly per language, so absence from
    // the source table is unambiguous however the key is written.
    const catalogs = legacy({
      'App/en.lproj/L.strings': '"Save card" = "Save card";\n',
      'App/de.lproj/L.strings': '"Save card" = "Karte";\n"Old copy" = "Alter Text";\n',
    })
    const found = issuesOf(catalogs).filter((i) => i.class === 'orphanKey')
    expect(found.map((i) => i.key)).toEqual(['Old copy'])
  })

  it('can be switched off', () => {
    const catalog = xcstrings({ dropped: { localizations: { de: unit('Verwaist') } } })
    expect(classesOf([catalog], 'orphanKeys: off')).not.toContain('orphanKey')
  })
})

describe('translations identical to the source', () => {
  const catalog = xcstrings({
    brand: { localizations: { en: unit('Acme'), de: unit('Acme') } },
    greeting: { localizations: { en: unit('Hello'), de: unit('Hallo') } },
  })

  it('is off by default, because proper nouns legitimately match', () => {
    expect(classesOf([catalog])).not.toContain('identicalToSource')
  })

  it('reports the untouched string once enabled', () => {
    const found = issuesOf([catalog], 'identicalToSource: warn').filter(
      (i) => i.class === 'identicalToSource',
    )
    expect(found).toHaveLength(1)
    expect(found[0]!.key).toBe('brand')
    expect(found[0]!.language).toBe('de')
    expect(found[0]!.detail).toContain('"Acme"')
  })

  it('never compares against a key that is only guessed to be the source', () => {
    const literal = xcstrings({ Acme: { localizations: { de: unit('Acme') } } })
    expect(classesOf([literal], 'identicalToSource: warn')).not.toContain('identicalToSource')
  })

  it('respects ignore.keys, which is how a project keeps its proper nouns quiet', () => {
    const classes = classesOf(
      [catalog],
      "identicalToSource: warn\nignore:\n  keys: ['brand']\n",
    )
    expect(classes).not.toContain('identicalToSource')
  })
})

describe('the rule runner', () => {
  it('skips a rule whose classes are all switched off', () => {
    const catalog = xcstrings({
      a: { localizations: { en: unit('A'), de: unit('Ah') } },
      b: { localizations: { en: unit('A'), de: unit('Be') } },
    })
    expect(classesOf([catalog])).toEqual(['duplicateValue'])
    expect(classesOf([catalog], 'duplicateValues: off')).toEqual([])
  })

  it('attributes every issue to the catalog it came from', () => {
    const a = parseXcstrings('App/A.xcstrings', JSON.stringify({
      sourceLanguage: 'en',
      strings: { k: { localizations: { en: unit('K') } } },
    }))
    const b = parseXcstrings('App/B.xcstrings', JSON.stringify({
      sourceLanguage: 'en',
      strings: { j: { localizations: { en: unit('J'), de: unit('Jott') } } },
    }))
    for (const issue of issuesOf([a, b])) {
      expect(issue.loc.file).toBe(issue.catalog)
    }
  })
})

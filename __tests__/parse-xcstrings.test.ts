import { describe, expect, it } from 'vitest'
import { parseXcstrings } from '../src/core/parse-xcstrings.js'
import { collectLeaves, leafPathLabel, leafShape } from '../src/core/value-node.js'
import { CatalogParseError } from '../src/core/types.js'
import { loadFixture } from './helpers.js'

const parse = (name: string) =>
  parseXcstrings(`Fixtures/${name}`, loadFixture('xcstrings', name))

describe('catalog shape', () => {
  it('reads source language, version and every language present', () => {
    const catalog = parse('complete.xcstrings')
    expect(catalog.sourceLanguage).toBe('en')
    expect(catalog.version).toBe('1.0')
    expect(catalog.format).toBe('xcstrings')
    expect(catalog.path).toBe('Fixtures/complete.xcstrings')
    expect(catalog.languages).toEqual(['de', 'en', 'fr'])
  })

  it('preserves entry order and per-entry metadata', () => {
    const catalog = parse('complete.xcstrings')
    expect(catalog.entries.map((e) => e.key)).toEqual([
      'app.greeting',
      'app.title',
      'settings.done',
    ])
    const greeting = catalog.entries[0]!
    expect(greeting.comment).toBe('Shown on the home screen')
    expect(greeting.extractionState).toBe('manual')
    expect(greeting.shouldTranslate).toBe(true)
    expect(Object.keys(greeting.localizations).sort()).toEqual(['de', 'en', 'fr'])
    expect(greeting.localizations.de!.unit).toEqual({
      state: 'translated',
      value: 'Hallo',
    })
  })
})

describe('line resolution', () => {
  it('points each key at its own line, not line 1', () => {
    const catalog = parse('complete.xcstrings')
    expect(catalog.entries.map((e) => e.loc.line)).toEqual([4, 28, 51])
    expect(catalog.entries[0]!.loc.file).toBe('Fixtures/complete.xcstrings')
  })

  it('points a localization at its stringUnit, which is where a bad value lives', () => {
    const catalog = parse('complete.xcstrings')
    // "de" key is on line 8; its stringUnit opens on line 9.
    expect(catalog.entries[0]!.localizations.de!.loc.line).toBe(9)
  })

  it('falls back to the language key when there is no top-level stringUnit', () => {
    const catalog = parse('variations.xcstrings')
    // inbox.count / "en" is on line 8 and has variations rather than a unit.
    expect(catalog.entries[0]!.localizations.en!.loc.line).toBe(8)
  })

  it('gives every variation branch a distinct line', () => {
    const catalog = parse('variations.xcstrings')
    const en = catalog.entries[0]!.localizations.en!
    const lines = collectLeaves(en).map((l) => l.loc.line)
    expect(new Set(lines).size).toBe(lines.length)
    expect(Math.min(...lines)).toBeGreaterThan(8)
  })
})

describe('variations', () => {
  it('parses a flat plural group', () => {
    const catalog = parse('variations.xcstrings')
    const entry = catalog.entries.find((e) => e.key === 'inbox.count')!
    const en = entry.localizations.en!
    expect(en.variations).toHaveLength(1)
    expect(en.variations![0]!.kind).toBe('plural')
    expect(Object.keys(en.variations![0]!.branches).sort()).toEqual(['one', 'other'])
    expect(Object.keys(entry.localizations.ja!.variations![0]!.branches)).toEqual(['other'])
  })

  it('parses device variations with a nested plural group', () => {
    const catalog = parse('variations.xcstrings')
    const entry = catalog.entries.find((e) => e.key === 'sidebar.hint')!
    const shape = [...leafShape(entry.localizations.en!)].sort()
    expect(shape).toEqual([
      'device.ipad / plural.one',
      'device.ipad / plural.other',
      'device.iphone',
    ])
    expect([...leafShape(entry.localizations.de!)].sort()).toEqual(shape)
  })

  it('collects leaf values in tree order', () => {
    const catalog = parse('variations.xcstrings')
    const entry = catalog.entries.find((e) => e.key === 'sidebar.hint')!
    const leaves = collectLeaves(entry.localizations.en!)
    expect(leaves.map((l) => [leafPathLabel(l.path), l.unit.value])).toEqual([
      ['device.ipad / plural.one', '%lld item in the sidebar'],
      ['device.ipad / plural.other', '%lld items in the sidebar'],
      ['device.iphone', 'Swipe for the menu'],
    ])
  })
})

describe('substitutions', () => {
  it('parses named substitutions with their own plural trees', () => {
    const catalog = parse('variations.xcstrings')
    const entry = catalog.entries.find((e) => e.key === 'transfer.summary')!
    const en = entry.localizations.en!
    expect(en.unit!.value).toBe('%1$#@files@ in %2$#@folders@')
    expect(Object.keys(en.substitutions!).sort()).toEqual(['files', 'folders'])

    const files = en.substitutions!.files!
    expect(files.argNum).toBe(1)
    expect(files.formatSpecifier).toBe('lld')
    expect(collectLeaves(files).map((l) => l.unit.value)).toEqual(['%arg file', '%arg files'])
  })
})

describe('tolerated edge cases', () => {
  const catalog = parse('edge.xcstrings')
  const byKey = (k: string) => catalog.entries.find((e) => e.key === k)

  it('skips the empty key rather than crashing', () => {
    expect(catalog.entries.map((e) => e.key)).not.toContain('')
    expect(catalog.entries).toHaveLength(6)
  })

  it('treats an entry with no localizations block as having none', () => {
    expect(byKey('bare.entry')!.localizations).toEqual({})
    expect(byKey('no.localizations')!.localizations).toEqual({})
    expect(byKey('empty.localizations')!.localizations).toEqual({})
  })

  it('defaults a missing state to translated and a missing value to empty', () => {
    expect(byKey('unit.without.state')!.localizations.de!.unit).toEqual({
      state: 'translated',
      value: 'Zustand fehlt',
    })
    expect(byKey('unit.without.value')!.localizations.de!.unit).toEqual({
      state: 'new',
      value: '',
    })
  })

  it('records shouldTranslate: false without dropping the entry', () => {
    expect(byKey('not.translatable')!.shouldTranslate).toBe(false)
  })

  it('still reports every language it saw', () => {
    expect(catalog.languages).toEqual(['de', 'en'])
  })
})

describe('failure modes', () => {
  it('rejects malformed JSON with a file, line and column', () => {
    let thrown: unknown
    try {
      parse('malformed.xcstrings')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CatalogParseError)
    const error = thrown as CatalogParseError
    expect(error.file).toBe('Fixtures/malformed.xcstrings')
    expect(error.line).toBe(1)
    expect(error.message).toMatch(/invalid JSON/)
    expect(error.message).not.toMatch(/undefined/)
  })

  it('rejects a non-object entry with the offending key named', () => {
    expect(() =>
      parseXcstrings('a.xcstrings', '{"strings":{"oops":"not an object"}}'),
    ).toThrowError(/entry "oops" must be a JSON object/)
  })

  it('rejects a top-level array', () => {
    expect(() => parseXcstrings('a.xcstrings', '[]')).toThrowError(/JSON object/)
  })
})

describe('encoding', () => {
  it('parses a file with a UTF-8 BOM', () => {
    const catalog = parse('bom.xcstrings')
    expect(catalog.entries.map((e) => e.key)).toEqual(['bom.key'])
    expect(catalog.entries[0]!.loc.line).toBe(4)
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyze } from '../src/core/analyze.js'
import { defaultConfig } from '../src/core/config.js'
import {
  assembleLegacyCatalogs,
  decodeTextFile,
  legacyFileInfo,
  parseStringsFile,
  parseStringsdictFile,
} from '../src/core/parse-strings.js'
import { collectLeaves } from '../src/core/value-node.js'
import { CatalogParseError } from '../src/core/types.js'
import { fixturePath } from './helpers.js'

const read = (...parts: string[]) => readFileSync(fixturePath(...parts))

const legacyFile = (...parts: string[]) => ({
  path: `App/${parts.join('/')}`,
  buffer: read('legacy', ...parts),
})

describe('encoding detection', () => {
  it('reads UTF-16LE with a BOM', () => {
    const text = decodeTextFile(read('legacy', 'de.lproj', 'Localizable.strings'))
    expect(text).toContain('"greeting" = "Hallo";')
    // A UTF-8 read of this file would leave interleaved NULs behind.
    expect(text).not.toContain(String.fromCharCode(0))
  })

  it('reads UTF-16BE with no BOM', () => {
    expect(decodeTextFile(read('legacy', 'de.lproj', 'NoBom.strings'))).toContain('"Hallo"')
  })

  it('reads plain UTF-8', () => {
    expect(decodeTextFile(read('legacy', 'en.lproj', 'Localizable.strings'))).toContain('"Hello"')
  })

  it('strips a UTF-8 BOM', () => {
    expect(decodeTextFile(Buffer.from('\ufeff"a" = "b";', 'utf8'))).toBe('"a" = "b";')
  })

  it('does not mistake a short ASCII file for UTF-16', () => {
    expect(decodeTextFile(Buffer.from('"a" = "b";', 'utf8'))).toBe('"a" = "b";')
  })
})

describe('.strings parsing', () => {
  const entries = parseStringsFile(
    'App/en.lproj/Localizable.strings',
    read('legacy', 'en.lproj', 'Localizable.strings'),
  )
  const byKey = (key: string) => entries.find((e) => e.key === key)

  it('reads every entry', () => {
    expect(entries.map((e) => e.key)).toEqual([
      'greeting',
      'farewell',
      'quoted',
      'escaped',
      'unicode',
      'count',
      'self_valued',
      'bare_key',
    ])
  })

  it('unescapes quotes, tabs, newlines and \\U escapes', () => {
    expect(byKey('quoted')!.value).toBe('She said "hi"')
    expect(byKey('escaped')!.value).toBe('Tab\there and a newline\nhere')
    expect(byKey('unicode')!.value).toBe('Café')
  })

  it('treats "key"; as key-equals-value', () => {
    expect(byKey('self_valued')!.value).toBe('self_valued')
  })

  it('accepts a bare identifier key', () => {
    expect(byKey('bare_key')!.value).toBe('Bare identifier key')
  })

  it('attaches the preceding comment in either style', () => {
    expect(byKey('greeting')!.comment).toBe('Greeting on the home screen')
    expect(byKey('farewell')!.comment).toBe('Shown when leaving')
    expect(byKey('quoted')!.comment).toBeUndefined()
  })

  it('gives each key its own line', () => {
    expect(byKey('greeting')!.loc.line).toBe(2)
    expect(byKey('farewell')!.loc.line).toBe(5)
    expect(byKey('greeting')!.loc.file).toBe('App/en.lproj/Localizable.strings')
  })

  it('reports a missing semicolon with a line, not a stack trace', () => {
    let thrown: unknown
    try {
      parseStringsFile('App/en.lproj/Broken.strings', read('legacy', 'en.lproj', 'Broken.strings'))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CatalogParseError)
    expect((thrown as CatalogParseError).message).toMatch(
      /expected ";" after the value for "broken"/,
    )
    expect((thrown as CatalogParseError).line).toBe(3)
  })
})

describe('.stringsdict parsing', () => {
  const entries = parseStringsdictFile(
    'App/en.lproj/Localizable.stringsdict',
    read('legacy', 'en.lproj', 'Localizable.stringsdict'),
  )

  it('reads each top-level key', () => {
    expect(entries.map((e) => e.key)).toEqual(['file_count', 'entity_escapes'])
  })

  it('maps a substitution onto the same shape a String Catalog uses', () => {
    const files = entries[0]!.localization.substitutions!.files!
    expect(entries[0]!.localization.unit!.value).toBe('%#@files@')
    expect(files.formatSpecifier).toBe('lld')
    expect(collectLeaves(files).map((l) => l.unit.value)).toEqual(['%lld file', '%lld files'])
  })

  it('decodes XML entities', () => {
    const n = entries[1]!.localization.substitutions!.n!
    expect(collectLeaves(n)[0]!.unit.value).toBe('%lld & more <here>')
  })

  it('gives each key a real line', () => {
    expect(entries[0]!.loc.line).toBe(5)
    expect(entries[1]!.loc.line).toBeGreaterThan(entries[0]!.loc.line)
  })
})

describe('lproj layout', () => {
  it('pulls the language and table out of a path', () => {
    expect(legacyFileInfo('App/Resources/de.lproj/Localizable.strings')).toEqual({
      baseDir: 'App/Resources',
      language: 'de',
      table: 'Localizable',
      extension: 'strings',
    })
  })

  it('recognises stringsdict', () => {
    expect(legacyFileInfo('a/pl.lproj/X.stringsdict')?.extension).toBe('stringsdict')
  })

  it('ignores a file that is not under an lproj', () => {
    expect(legacyFileInfo('App/Localizable.strings')).toBeUndefined()
  })
})

describe('assembling tables', () => {
  const catalogs = assembleLegacyCatalogs([
    legacyFile('en.lproj', 'Localizable.strings'),
    legacyFile('de.lproj', 'Localizable.strings'),
    legacyFile('fr.lproj', 'Localizable.strings'),
    legacyFile('en.lproj', 'Localizable.stringsdict'),
    legacyFile('pl.lproj', 'Localizable.stringsdict'),
  ])

  it('produces one catalog per table', () => {
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]!.path).toBe('App/Localizable.strings')
    expect(catalogs[0]!.format).toBe('strings')
  })

  it('merges the strings and stringsdict halves of one table', () => {
    const keys = catalogs[0]!.entries.map((e) => e.key)
    expect(keys).toContain('greeting')
    expect(keys).toContain('file_count')
    expect(catalogs[0]!.languages).toEqual(['de', 'en', 'fr', 'pl'])
  })

  it('picks en as the source language when there is no Base', () => {
    expect(catalogs[0]!.sourceLanguage).toBe('en')
  })

  it('prefers Base.lproj as the source language', () => {
    const withBase = assembleLegacyCatalogs([
      { path: 'App/Base.lproj/T.strings', buffer: Buffer.from('"a" = "A";') },
      { path: 'App/en.lproj/T.strings', buffer: Buffer.from('"a" = "A";') },
    ])
    expect(withBase[0]!.sourceLanguage).toBe('Base')
  })

  it('keeps issues pointing at the real per-language file', () => {
    const german = catalogs[0]!.entries.find((e) => e.key === 'greeting')!.localizations.de!
    expect(german.loc.file).toBe('App/de.lproj/Localizable.strings')
  })

  it('keeps identically named tables in different modules apart', () => {
    const modules = assembleLegacyCatalogs(
      (
        [
          ['ModuleA', 'de.lproj'],
          ['ModuleA', 'en.lproj'],
          ['ModuleB', 'de.lproj'],
          ['ModuleB', 'en.lproj'],
        ] as const
      ).map(([module, lproj]) => ({
        path: `${module}/Resources/${lproj}/Feature.strings`,
        buffer: read('multi-module', module, 'Resources', lproj, 'Feature.strings'),
      })),
    )
    expect(modules.map((c) => c.path)).toEqual([
      'ModuleA/Resources/Feature.strings',
      'ModuleB/Resources/Feature.strings',
    ])
    // ModuleA is short a German string; ModuleB is complete.
    const { issues } = analyze(modules, defaultConfig())
    expect(issues.map((i) => [i.catalog, i.key, i.language])).toEqual([
      ['ModuleA/Resources/Feature.strings', 'feature.body', 'de'],
    ])
  })
})

describe('legacy tables through the analyzer', () => {
  const catalogs = assembleLegacyCatalogs([
    legacyFile('en.lproj', 'Localizable.strings'),
    legacyFile('de.lproj', 'Localizable.strings'),
    legacyFile('fr.lproj', 'Localizable.strings'),
    legacyFile('en.lproj', 'Localizable.stringsdict'),
    legacyFile('pl.lproj', 'Localizable.stringsdict'),
  ])
  const { issues, coverage } = analyze(catalogs, defaultConfig())
  const forKey = (key: string, language: string) =>
    issues.filter((i) => i.key === key && i.language === language)

  it('finds the empty German value', () => {
    expect(forKey('bare_key', 'de')[0]!.class).toBe('empty')
  })

  it('finds the format specifier mismatch in the UTF-16 file', () => {
    const issue = forKey('count', 'de').find((i) => i.class === 'formatSpecifier')!
    expect(issue.severity).toBe('error')
    expect(issue.message).toBe('de: expected %lld at position 1, found %@')
    expect(issue.loc.file).toBe('App/de.lproj/Localizable.strings')
  })

  it('finds the missing Polish plural categories from the stringsdict', () => {
    const issue = forKey('file_count', 'pl').find((i) => i.class === 'pluralCoverage')!
    expect(issue.message).toMatch(/missing the few, many plural categories/)
  })

  it('scores each language against the pooled key set', () => {
    // 10 keys across the table: 8 from the .strings files plus file_count and
    // entity_escapes from the stringsdicts. French ships no stringsdict at all,
    // which is exactly the gap pooling is meant to surface.
    expect(coverage.fr).toMatchObject({ translatable: 10, translated: 8, percent: 80 })
    expect(coverage.de).toMatchObject({ translatable: 10, translated: 7, percent: 70 })
    expect(coverage.pl).toMatchObject({ translatable: 10, translated: 1, percent: 10 })
  })
})

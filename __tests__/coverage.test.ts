import { describe, expect, it } from 'vitest'
import { analyze } from '../src/core/analyze.js'
import { parseConfig } from '../src/core/config.js'
import { belowThreshold, percentOf } from '../src/core/coverage.js'
import { parseXcstrings } from '../src/core/parse/xcstrings.js'
import type { LanguageCoverage } from '../src/core/types.js'

const coverage = (
  language: string,
  translated: number,
  translatable: number,
): LanguageCoverage => ({
  language,
  translated,
  translatable,
  percent: percentOf(translated, translatable),
})

const asRecord = (...entries: LanguageCoverage[]): Record<string, LanguageCoverage> =>
  Object.fromEntries(entries.map((entry) => [entry.language, entry]))

describe('the percentage', () => {
  it('is 100 only when nothing is outstanding', () => {
    expect(percentOf(3, 3)).toBe(100)
    expect(percentOf(0, 0)).toBe(100)
  })

  it('never rounds up to 100', () => {
    // Regression: 2999/3000 is 99.9666...%, and rounding to the nearest tenth
    // gave 100.0 -- a figure indistinguishable from a finished translation.
    expect(percentOf(2999, 3000)).toBe(99.9)
    expect(percentOf(9999, 10000)).toBe(99.9)
  })

  it('rounds down rather than to nearest, so it never overstates', () => {
    expect(percentOf(2, 3)).toBe(66.6)
    expect(percentOf(1, 3)).toBe(33.3)
  })

  it('is 0 when nothing is translated', () => {
    expect(percentOf(0, 42)).toBe(0)
  })
})

describe('the threshold gate', () => {
  it('compares counts, not the displayed percentage', () => {
    // The figure reads 99.9%, but one string really is missing, so a
    // `threshold: 100` gate has to catch it.
    const shortfalls = belowThreshold(asRecord(coverage('de', 2999, 3000)), 100)
    expect(shortfalls.map((s) => s.language)).toEqual(['de'])
    expect(shortfalls[0]!.translated).toBe(2999)
  })

  it('passes a genuinely complete language', () => {
    expect(belowThreshold(asRecord(coverage('de', 3000, 3000)), 100)).toEqual([])
  })

  it('passes a language with nothing to translate', () => {
    expect(belowThreshold(asRecord(coverage('de', 0, 0)), 100)).toEqual([])
  })

  it('honours a threshold below 100', () => {
    expect(belowThreshold(asRecord(coverage('de', 1, 2)), 50)).toEqual([])
    expect(belowThreshold(asRecord(coverage('de', 1, 3)), 50).map((s) => s.language)).toEqual(['de'])
  })

  it('gates only the required languages when they are listed', () => {
    const all = asRecord(coverage('de', 1, 2), coverage('fr', 1, 2))
    expect(belowThreshold(all, 100, { required: ['de'] }).map((s) => s.language)).toEqual(['de'])
  })

  it('reports a required language no catalog has', () => {
    expect(belowThreshold({}, 100, { required: ['xx'] })).toEqual([
      { language: 'xx', percent: 0, threshold: 100, translatable: 0, translated: 0 },
    ])
  })

  it('never gates a language that is only ever a source language', () => {
    // Regression: `required: [en, de]` with `en` as the source reported en at
    // 0%, because a source language has no translations to count.
    const shortfalls = belowThreshold(asRecord(coverage('de', 2, 2)), 100, {
      required: ['en', 'de'],
      sourceLanguages: ['en'],
    })
    expect(shortfalls).toEqual([])
  })

  it('still gates a language that is a source in one catalog and a target in another', () => {
    const shortfalls = belowThreshold(asRecord(coverage('de', 1, 2)), 100, {
      required: ['de'],
      sourceLanguages: ['en', 'de'],
    })
    expect(shortfalls.map((s) => s.language)).toEqual(['de'])
  })

  it('lists the worst-covered language first', () => {
    const all = asRecord(coverage('de', 8, 10), coverage('fr', 2, 10), coverage('ja', 5, 10))
    expect(belowThreshold(all, 100).map((s) => s.language)).toEqual(['fr', 'ja', 'de'])
  })
})

describe('coverage over real catalogs', () => {
  const catalog = (strings: Record<string, unknown>) =>
    parseXcstrings('App/L.xcstrings', JSON.stringify({ sourceLanguage: 'en', strings }))

  const unit = (state: string, value: string) => ({ stringUnit: { state, value } })

  it('counts a key once even when it is declared twice', () => {
    // Regression: a duplicated key produced two entries, so one key counted as
    // two translatable strings and dragged the percentage down.
    const json = `{"sourceLanguage":"en","strings":{
      "k":{"localizations":{"en":{"stringUnit":{"state":"translated","value":"A"}},"de":{"stringUnit":{"state":"translated","value":"Ah"}}}},
      "k":{"localizations":{"en":{"stringUnit":{"state":"translated","value":"B"}},"de":{"stringUnit":{"state":"translated","value":"Be"}}}}
    }}`
    const result = analyze([parseXcstrings('App/L.xcstrings', json)], parseConfig(''))
    expect(result.coverage.de).toMatchObject({ translatable: 1, translated: 1, percent: 100 })
  })

  it('reports every source language it saw', () => {
    const result = analyze([catalog({ a: { localizations: { en: unit('translated', 'A') } } })], parseConfig(''))
    expect(result.sourceLanguages).toEqual(['en'])
  })

  it('keeps a language in the table even when every key is missing', () => {
    const result = analyze(
      [
        catalog({
          a: { localizations: { en: unit('translated', 'A'), de: unit('translated', 'Ah') } },
          b: { localizations: { en: unit('translated', 'B'), de: unit('translated', 'Be') } },
        }),
      ],
      parseConfig('required: [de, fr]'),
    )
    expect(result.languages).toEqual(['de', 'fr'])
    expect(result.coverage.fr).toMatchObject({ translatable: 2, translated: 0, percent: 0 })
  })
})

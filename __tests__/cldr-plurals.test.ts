import { describe, expect, it } from 'vitest'
import {
  baseLanguage,
  missingPluralCategories,
  requiredPluralCategories,
} from '../src/core/cldr-plurals.js'

describe('required categories', () => {
  it.each([
    ['en', ['one', 'other']],
    ['de', ['one', 'other']],
    ['ja', ['other']],
    ['zh', ['other']],
    ['ko', ['other']],
    ['pl', ['one', 'few', 'many', 'other']],
    ['ru', ['one', 'few', 'many', 'other']],
    ['cs', ['one', 'few', 'many', 'other']],
    ['hr', ['one', 'few', 'other']],
    ['ro', ['one', 'few', 'other']],
    ['sl', ['one', 'two', 'few', 'other']],
    ['ga', ['one', 'two', 'few', 'many', 'other']],
    ['he', ['one', 'two', 'other']],
    ['lv', ['zero', 'one', 'other']],
    ['ar', ['zero', 'one', 'two', 'few', 'many', 'other']],
    ['cy', ['zero', 'one', 'two', 'few', 'many', 'other']],
    ['fr', ['one', 'many', 'other']],
    ['es', ['one', 'many', 'other']],
  ])('%s', (locale, expected) => {
    expect(requiredPluralCategories(locale).categories).toEqual(expected)
  })

  it('always includes other', () => {
    for (const locale of ['en', 'ja', 'pl', 'ar', 'lv', 'sl', 'qqq']) {
      expect(requiredPluralCategories(locale).categories).toContain('other')
    }
  })
})

describe('locale normalisation', () => {
  it.each([
    ['pt-BR', 'pt'],
    ['pt_PT', 'pt'],
    ['zh-Hans', 'zh'],
    ['zh_Hant', 'zh'],
    ['es-419', 'es'],
    ['en-GB', 'en'],
    ['fr-CA', 'fr'],
  ])('%s resolves through %s', (locale, base) => {
    expect(baseLanguage(locale)).toBe(base)
    expect(requiredPluralCategories(locale).categories).toEqual(
      requiredPluralCategories(base).categories,
    )
    expect(requiredPluralCategories(locale).known).toBe(true)
  })
})

describe('unknown locales', () => {
  it('falls back to one/other and says so', () => {
    const result = requiredPluralCategories('xyz')
    expect(result.categories).toEqual(['one', 'other'])
    expect(result.known).toBe(false)
  })
})

describe('missing categories', () => {
  it('reports what Polish is short of', () => {
    const { missing, known } = missingPluralCategories('pl', ['one', 'other'])
    expect(missing).toEqual(['few', 'many'])
    expect(known).toBe(true)
  })

  it('is satisfied by Japanese supplying only other', () => {
    expect(missingPluralCategories('ja', ['other']).missing).toEqual([])
  })

  it('does not complain about extra categories', () => {
    expect(missingPluralCategories('ja', ['one', 'other']).missing).toEqual([])
    expect(missingPluralCategories('en', ['one', 'few', 'other']).missing).toEqual([])
  })

  it('reports a missing other', () => {
    expect(missingPluralCategories('en', ['one']).missing).toEqual(['other'])
  })

  it('reports all six for Arabic given only one/other', () => {
    expect(missingPluralCategories('ar', ['one', 'other']).missing).toEqual([
      'zero',
      'two',
      'few',
      'many',
    ])
  })
})

import { describe, expect, it } from 'vitest'
import {
  compareFormatSpecifiers,
  parseFormatSpecifiers,
} from '../src/core/format-specifiers.js'

const raws = (s: string) => parseFormatSpecifiers(s).map((f) => f.raw)
const kinds = (s: string) => parseFormatSpecifiers(s).map((f) => f.kind)

describe('tokenising', () => {
  it('finds plain conversions', () => {
    expect(raws('You have %lld items in %@')).toEqual(['%lld', '%@'])
  })

  it('assigns sequential positions when none are explicit', () => {
    expect(parseFormatSpecifiers('%@ %lld %f').map((f) => f.position)).toEqual([1, 2, 3])
  })

  it('honours explicit positions and does not advance the implicit counter', () => {
    const parsed = parseFormatSpecifiers('%2$@ then %1$lld')
    expect(parsed.map((f) => f.position)).toEqual([2, 1])
    expect(parsed.every((f) => f.explicitPosition)).toBe(true)
  })

  it('ignores a literal %%', () => {
    expect(raws('100%% sure, %lld times')).toEqual(['%lld'])
  })

  it('handles flags, width and precision', () => {
    const parsed = parseFormatSpecifiers('%-8.2f and %+05lld and %#x')
    expect(parsed.map((f) => f.raw)).toEqual(['%-8.2f', '%+05lld', '%#x'])
    expect(parsed.map((f) => f.typeClass)).toEqual(['float', 'integer', 'integer'])
  })

  it('classifies width from the length modifier', () => {
    expect(parseFormatSpecifiers('%d').map((f) => f.width)).toEqual(['default'])
    expect(parseFormatSpecifiers('%lld').map((f) => f.width)).toEqual(['longlong'])
    expect(parseFormatSpecifiers('%ld').map((f) => f.width)).toEqual(['long'])
    expect(parseFormatSpecifiers('%zd').map((f) => f.width)).toEqual(['size'])
    expect(parseFormatSpecifiers('%qi').map((f) => f.width)).toEqual(['longlong'])
  })

  it('flags * width as consuming an extra argument', () => {
    expect(parseFormatSpecifiers('%*d')[0]!.consumesExtraArgs).toBe(true)
  })

  it('does not treat a trailing lone %% as a specifier', () => {
    expect(raws('discount %')).toEqual([])
  })
})

describe('String Catalog extensions', () => {
  it('reads %#@name@ as a substitution, not as an object', () => {
    const parsed = parseFormatSpecifiers('%1$#@files@ in %2$#@folders@')
    expect(parsed.map((f) => f.kind)).toEqual(['substitution', 'substitution'])
    expect(parsed.map((f) => f.substitutionName)).toEqual(['files', 'folders'])
    expect(parsed.map((f) => f.position)).toEqual([1, 2])
    // The naive reading would have been "%1$@", i.e. an object.
    expect(parsed.every((f) => f.typeClass === undefined)).toBe(true)
  })

  it('reads a non-positional %#@name@', () => {
    const parsed = parseFormatSpecifiers('%#@count@')
    expect(parsed[0]!.substitutionName).toBe('count')
    expect(parsed[0]!.explicitPosition).toBe(false)
  })

  it('reads %arg as the substituted argument, not as %a followed by "rg"', () => {
    expect(kinds('%arg files')).toEqual(['argument'])
    expect(raws('%arg files')).toEqual(['%arg'])
  })

  it('still reads %a as a hex float when it is not %arg', () => {
    expect(parseFormatSpecifiers('%a')[0]!.typeClass).toBe('float')
    expect(parseFormatSpecifiers('%args')[0]!.typeClass).toBe('float')
  })
})

describe('comparison', () => {
  it('accepts an exact match', () => {
    expect(compareFormatSpecifiers('You have %lld items', 'Sie haben %lld Artikel')).toEqual([])
  })

  it('reports an object-for-integer swap as an error with specifics', () => {
    const [mismatch] = compareFormatSpecifiers('You have %lld items', 'Sie haben %@ Artikel')
    expect(mismatch).toMatchObject({ kind: 'type', severity: 'error', position: 1 })
    expect(mismatch!.message).toBe('expected %lld at position 1, found %@')
  })

  it('accepts a legitimate reordering via positional specifiers', () => {
    expect(compareFormatSpecifiers('%1$@ sent %2$lld files', '%2$lld Dateien von %1$@')).toEqual([])
  })

  it('catches a positional swap that changes the type at a position', () => {
    const mismatches = compareFormatSpecifiers('%1$@ sent %2$lld', '%1$lld von %2$@')
    expect(mismatches).toHaveLength(2)
    expect(mismatches.map((m) => m.kind)).toEqual(['type', 'type'])
    expect(mismatches[0]!.message).toBe('expected %1$@ at position 1, found %1$lld')
  })

  it('reports a dropped specifier', () => {
    const [mismatch] = compareFormatSpecifiers('%@ has %lld items', 'Hat Artikel')
    expect(mismatch).toMatchObject({ kind: 'missing', severity: 'error', position: 1 })
    expect(mismatch!.message).toMatch(/found nothing/)
  })

  it('reports an invented specifier', () => {
    const mismatches = compareFormatSpecifiers('Hello', 'Hallo %@')
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]).toMatchObject({ kind: 'extra', severity: 'error', position: 1 })
  })

  it('warns rather than errors on a width-only difference', () => {
    const [mismatch] = compareFormatSpecifiers('%lld items', '%d Artikel')
    expect(mismatch).toMatchObject({ kind: 'width', severity: 'warn' })
    expect(mismatch!.message).toMatch(/same type, different width/)
  })

  it('treats %d and %i as the same', () => {
    expect(compareFormatSpecifiers('%d', '%i')).toEqual([])
  })

  it('ignores literal percents on both sides', () => {
    expect(compareFormatSpecifiers('%lld%% done', '%lld%% erledigt')).toEqual([])
  })

  it('resolves substitutions to their declared specifier', () => {
    const mismatches = compareFormatSpecifiers('%#@files@', '%lld Dateien', {
      sourceSubstitutions: { files: { formatSpecifier: 'lld' } },
    })
    expect(mismatches).toEqual([])
  })

  it('catches a substitution declared as an integer rendered as an object', () => {
    const [mismatch] = compareFormatSpecifiers('%#@files@', '%@ Dateien', {
      sourceSubstitutions: { files: { formatSpecifier: 'lld' } },
    })
    expect(mismatch).toMatchObject({ kind: 'type', severity: 'error' })
  })

  it('stays silent when a substitution type cannot be resolved', () => {
    expect(compareFormatSpecifiers('%#@files@', '%@ Dateien')).toEqual([])
  })

  it('says nothing about strings with no specifiers', () => {
    expect(compareFormatSpecifiers('Hello', 'Hallo')).toEqual([])
  })

  it('tolerates a position repeated on one side', () => {
    expect(compareFormatSpecifiers('%1$@ and %1$@', '%1$@')).toEqual([])
  })
})

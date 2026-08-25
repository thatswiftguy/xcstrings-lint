import { describe, expect, it } from 'vitest'
import { analyze } from '../src/core/analyze.js'
import { defaultConfig, parseConfig, type ResolvedConfig } from '../src/core/config.js'
import { parseXcstrings } from '../src/core/parse/xcstrings.js'
import { buildReport } from '../src/lint.js'
import { DEFAULT_MAX_PER_LEVEL, planAnnotations } from '../src/report/annotations.js'
import { COMMENT_MARKER, isOurComment, renderComment, truncate } from '../src/report/comment.js'
import { renderParseErrors, renderSummary } from '../src/report/summary.js'
import {
  code,
  groupLanguagesByIssues,
  percent,
  renderKeySections,
  renderLanguageCell,
  renderLanguageTable,
} from '../src/report/model.js'
import type { ReportInput } from '../src/report/model.js'
import type { Issue } from '../src/core/types.js'

const config = defaultConfig()

type Cell = string | null
function catalog(entries: Record<string, Record<string, Cell>>): string {
  const strings: Record<string, unknown> = {}
  for (const [key, langs] of Object.entries(entries)) {
    const localizations: Record<string, unknown> = {}
    for (const [language, value] of Object.entries(langs)) {
      if (value === null) continue
      localizations[language] = { stringUnit: { state: 'translated', value } }
    }
    strings[key] = { extractionState: 'manual', localizations }
  }
  return JSON.stringify({ sourceLanguage: 'en', strings, version: '1.0' }, null, 2)
}

interface ScenarioOptions {
  threshold?: number
  config?: ResolvedConfig
}

function reportFor(files: Record<string, string>, options: ScenarioOptions = {}): ReportInput {
  const resolved = options.config ?? config
  const catalogs = Object.entries(files).map(([path, text]) => parseXcstrings(path, text))
  return buildReport(analyze(catalogs, resolved), {
    config: resolved,
    threshold: options.threshold ?? 100,
    filesScanned: catalogs.length,
  })
}

/** A payment flow with a missing translation, an empty one and a gap in Japanese. */
function failingScenario(): ReportInput {
  return reportFor({
    'App/Localizable.xcstrings': catalog({
      payment_save_card_title: { en: 'Save card', de: 'Karte', fr: 'Carte', ja: null },
      payment_save_card_subtitle: { en: 'Save for later', de: 'Später', fr: null, ja: null },
      payment_cvv_hint: { en: 'CVV', de: 'CVV', fr: '', ja: null },
    }),
  })
}

/** Nothing blocking, but two keys share a source string and one is orphaned. */
function warningScenario(): ReportInput {
  return reportFor({
    'App/Localizable.xcstrings': catalog({
      cart_title: { en: 'Basket', de: 'Korb', fr: 'Panier' },
      checkout_title: { en: 'Basket', de: 'Korb', fr: 'Panier' },
      dropped_key: { de: 'Verwaist', fr: 'Orphelin' },
    }),
  })
}

function cleanScenario(): ReportInput {
  return reportFor({
    'App/Localizable.xcstrings': catalog({
      a: { en: 'A', de: 'Ah', fr: 'Aa' },
      b: { en: 'B', de: 'Be', fr: 'Bé' },
    }),
  })
}

/** Coverage below the threshold, with every issue class switched off. */
function thresholdScenario(): ReportInput {
  return reportFor(
    {
      'App/Localizable.xcstrings': catalog({
        a: { en: 'A', de: 'Ah', fr: 'Aa' },
        b: { en: 'B', de: 'Be', fr: null },
      }),
    },
    { config: parseConfig('failOn: []\nwarnOn: []\nformatSpecifiers: off\norphanKeys: off') },
  )
}

/* -------------------------------------------------------------------------- */

describe('markdown helpers', () => {
  it('escapes pipes so a key cannot break out of a table cell', () => {
    expect(code('a|b')).toBe('`a\\|b`')
  })

  it('handles a key containing a backtick', () => {
    expect(code('a`b')).toBe('``a`b``')
  })

  it('formats percentages without trailing zeros', () => {
    expect(percent(100)).toBe('100%')
    expect(percent(99.4)).toBe('99.4%')
    expect(percent(0)).toBe('0%')
  })
})

describe('annotations', () => {
  const many = (count: number, severity: 'error' | 'warn'): Issue[] =>
    Array.from({ length: count }, (_, i) => ({
      class: 'missing' as const,
      severity,
      catalog: 'App/L.xcstrings',
      key: `key_${i}`,
      language: 'de',
      loc: { file: 'App/L.xcstrings', line: i + 2 },
      message: `no de translation`,
    }))

  it('caps each level independently rather than globally', () => {
    const plan = planAnnotations([...many(15, 'error'), ...many(15, 'warn')])
    expect(plan.annotations.filter((a) => a.level === 'error')).toHaveLength(DEFAULT_MAX_PER_LEVEL)
    expect(plan.annotations.filter((a) => a.level === 'warning')).toHaveLength(DEFAULT_MAX_PER_LEVEL)
    expect(plan.dropped).toEqual({ error: 5, warning: 5 })
    expect(plan.totalDropped).toBe(10)
  })

  it('keeps errors when the cap bites', () => {
    const plan = planAnnotations([...many(3, 'warn'), ...many(20, 'error')])
    expect(plan.annotations.slice(0, 10).every((a) => a.level === 'error')).toBe(true)
  })

  it('drops nothing when under the cap', () => {
    const plan = planAnnotations(many(4, 'error'))
    expect(plan.totalDropped).toBe(0)
  })

  it('points each annotation at a real line in its own file', () => {
    const plan = planAnnotations(failingScenario().errors)
    expect(plan.annotations.length).toBeGreaterThan(0)
    for (const annotation of plan.annotations) {
      expect(annotation.file).toBe('App/Localizable.xcstrings')
      expect(annotation.line).toBeGreaterThan(1)
      expect(annotation.title).toMatch(/^[A-Z][^:]+: \S/)
      expect(annotation.message).not.toBe('')
    }
  })

  it('titles each annotation with its issue class and key', () => {
    const titles = planAnnotations(failingScenario().errors).annotations.map((a) => a.title)
    expect(titles).toContain('Missing translation: payment_save_card_subtitle')
    expect(titles).toContain('Empty translation: payment_cvv_hint')
  })

  it('has a title for every issue class', () => {
    const warnings = warningScenario().warnings
    expect(warnings.length).toBeGreaterThan(0)
    for (const annotation of planAnnotations(warnings).annotations) {
      expect(annotation.title).not.toMatch(/undefined/)
    }
  })
})

const issue = (over: Partial<Issue> = {}): Issue => ({
  class: 'missing',
  severity: 'error',
  catalog: 'App/L.xcstrings',
  key: 'k',
  language: 'de',
  loc: { file: 'App/L.xcstrings', line: 2 },
  message: 'no translation',
  ...over,
})

describe('grouping languages', () => {
  it('puts languages with identical counts on one row', () => {
    const issues = ['de', 'fr', 'ja'].map((language) => issue({ language }))
    const groups = groupLanguagesByIssues(['de', 'fr', 'ja'], issues)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.languages).toEqual(['de', 'fr', 'ja'])
    expect(groups[0]!.total).toBe(1)
  })

  it('keeps languages apart when their counts differ', () => {
    const issues = [
      issue({ language: 'de' }),
      issue({ language: 'de', key: 'k2' }),
      issue({ language: 'fr' }),
    ]
    const groups = groupLanguagesByIssues(['de', 'fr'], issues)
    expect(groups.map((g) => g.languages)).toEqual([['de'], ['fr']])
    expect(groups.map((g) => g.total)).toEqual([2, 1])
  })

  it('separates languages that differ only by issue class', () => {
    const groups = groupLanguagesByIssues(
      ['de', 'fr'],
      [issue({ language: 'de', class: 'missing' }), issue({ language: 'fr', class: 'empty' })],
    )
    expect(groups).toHaveLength(2)
  })

  it('groups every clean language together', () => {
    const groups = groupLanguagesByIssues(['de', 'fr', 'ja'], [issue({ language: 'de' })])
    const clean = groups.find((g) => g.total === 0)!
    expect(clean.languages).toEqual(['fr', 'ja'])
  })

  it('sorts the worst-affected group first', () => {
    const groups = groupLanguagesByIssues(
      ['de', 'fr'],
      [issue({ language: 'fr' }), issue({ language: 'fr', key: 'k2' }), issue({ language: 'de' })],
    )
    expect(groups[0]!.languages).toEqual(['fr'])
  })
})

describe('language cells', () => {
  it('collapses a full sweep to "all N languages"', () => {
    expect(renderLanguageCell(['de', 'fr', 'ja'], 3)).toBe('all 3 languages')
  })

  it('lists them when only some are affected', () => {
    expect(renderLanguageCell(['de', 'fr'], 3)).toBe('`de`, `fr`')
  })

  it('truncates a very long list rather than filling the cell', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    expect(renderLanguageCell(many, 20)).toBe('`a`, `b`, `c`, `d`, `e`, `f`, `g`, `h` +2 more')
  })

  it('does not say "all 1 languages" for a single-language project', () => {
    expect(renderLanguageCell(['de'], 1)).toBe('`de`')
  })
})

describe('the summary table', () => {
  const issues = [
    ...['de', 'fr', 'ja'].map((language) => issue({ language, key: 'a' })),
    issue({ language: 'de', key: 'b', class: 'empty' }),
  ]
  const rendered = renderLanguageTable(['de', 'fr', 'ja'], issues)

  it('shows counts, never percentages', () => {
    expect(rendered).not.toMatch(/%/)
    expect(rendered).toContain('| Missing | Empty | Total |')
  })

  it('collapses the two identical languages onto one row', () => {
    expect(rendered).toContain('| `fr`, `ja` | 1 | — | **1** |')
    expect(rendered).toContain('| `de` | 1 | 1 | **2** |')
  })

  it('only has columns for classes that actually occurred', () => {
    expect(rendered).not.toContain('Stale')
    expect(rendered).not.toContain('Plurals')
  })

  it('renders nothing when there is nothing wrong', () => {
    expect(renderLanguageTable(['de', 'fr'], [])).toBe('')
  })

  it('leaves out languages with nothing wrong', () => {
    const table = renderLanguageTable(['de', 'fr'], [issue({ language: 'de' })])
    expect(table).toContain('`de`')
    expect(table).not.toContain('`fr`')
  })
})

describe('key sections', () => {
  const sections = renderKeySections(
    [
      issue({ language: 'de', key: 'a' }),
      issue({ language: 'fr', key: 'a' }),
      issue({ language: 'de', key: 'b', class: 'empty' }),
      issue({
        language: 'de',
        key: 'c',
        class: 'formatSpecifier',
        message: 'de: expected %lld at position 1, found %@',
      }),
    ],
    ['de', 'fr'],
    40,
  )

  it('opens one collapsed block per issue class', () => {
    expect(sections).toHaveLength(3)
    for (const section of sections) {
      expect(section).toMatch(/^<details><summary><b>.+<\/b> · \d+<\/summary>/)
      expect(section).not.toContain('<details open>')
    }
  })

  it('names the keys and the languages each is missing from', () => {
    expect(sections[0]).toContain('<b>Missing translations</b> · 2')
    expect(sections[0]).toContain('| `a` | all 2 languages |')
  })

  it('keeps classes apart so a crash is not buried in missing keys', () => {
    expect(sections[1]).toContain('<b>Empty values</b> · 1')
    expect(sections[2]).toContain('<b>Format specifier mismatches</b> · 1')
    expect(sections[2]).toContain('expected %lld at position 1, found %@')
  })

  it('lists the widest-reaching key first', () => {
    const wide = renderKeySections(
      [
        issue({ key: 'narrow', language: 'de' }),
        issue({ key: 'wide', language: 'de' }),
        issue({ key: 'wide', language: 'fr' }),
      ],
      ['de', 'fr'],
      40,
    )
    expect(wide[0]!.indexOf('`wide`')).toBeLessThan(wide[0]!.indexOf('`narrow`'))
  })
})

describe('sticky comment', () => {
  it('always carries the marker', () => {
    for (const input of [failingScenario(), cleanScenario(), thresholdScenario()]) {
      expect(renderComment(input)).toContain(COMMENT_MARKER)
    }
  })

  it('recognises its own comment and no one else’s', () => {
    expect(isOurComment(renderComment(cleanScenario()))).toBe(true)
    expect(isOurComment('LGTM!')).toBe(false)
    expect(isOurComment(undefined)).toBe(false)
  })

  it('renders a failing report', () => {
    expect(renderComment(failingScenario())).toMatchSnapshot()
  })

  it('renders a passing report', () => {
    expect(renderComment(cleanScenario())).toMatchSnapshot()
  })

  it('renders a report that only misses the coverage threshold', () => {
    expect(renderComment(thresholdScenario())).toMatchSnapshot()
  })

  it('states how far below the threshold each language is', () => {
    const input = thresholdScenario()
    expect(input.errors).toEqual([])
    expect(input.passed).toBe(false)
    expect(renderComment(input)).toContain('`fr` at 50%')
  })

  it('counts keys and languages rather than percentages when issues exist', () => {
    expect(renderComment(failingScenario())).not.toMatch(/\d%/)
  })

  it('keeps the detail collapsed so the summary reads first', () => {
    const body = renderComment(failingScenario())
    expect(body).not.toContain('<details open>')
    expect(body.indexOf('| Languages |')).toBeLessThan(body.indexOf('<details>'))
  })

  it('says how many files it checked', () => {
    expect(renderComment(cleanScenario())).toContain('1 file checked')
  })

  it('offers the warnings as an expandable section', () => {
    const input = warningScenario()
    expect(input.errors).toEqual([])
    expect(input.warnings.length).toBeGreaterThan(0)

    const body = renderComment(input)
    // Still a pass: warnings never decide the verdict.
    expect(body).toContain('**passed**')
    expect(body).toContain(
      `<details><summary><b>Warnings</b> · ${input.warnings.length} — not blocking</summary>`,
    )
  })

  it('names the warning keys, not just a count', () => {
    const body = renderComment(warningScenario())
    expect(body).toContain('**Duplicate source strings** ·')
    expect(body).toContain('`checkout_title`')
    expect(body).toContain('**Orphan keys** ·')
  })

  it('does not nest one collapsible block inside another', () => {
    const body = renderComment(warningScenario())
    const opens = (body.match(/<details>/g) ?? []).length
    const closes = (body.match(/<\/details>/g) ?? []).length
    expect(opens).toBe(closes)
    // Exactly one block: the warnings. Its class sections render flat inside it.
    expect(opens).toBe(1)
  })

  it('omits the warnings section when there are none', () => {
    const body = renderComment(cleanScenario())
    expect(body).not.toContain('Warnings')
    expect(body).not.toContain('<details>')
  })

  it('renders a passing report that carries warnings', () => {
    expect(renderComment(warningScenario())).toMatchSnapshot()
  })

  it('keeps the marker when the body has to be truncated', () => {
    const body = renderComment(failingScenario())
    const cut = truncate(body, 300)
    expect(cut.length).toBeLessThanOrEqual(300)
    expect(cut).toContain(COMMENT_MARKER)
    expect(cut).toContain('_Report truncated._')
    expect(isOurComment(cut)).toBe(true)
  })

  it('leaves a short body alone', () => {
    const body = renderComment(cleanScenario())
    expect(truncate(body)).toBe(body)
  })
})

describe('job summary', () => {
  it('renders a failing report', () => {
    expect(renderSummary(failingScenario())).toMatchSnapshot()
  })

  it('renders a threshold-only report', () => {
    expect(renderSummary(thresholdScenario())).toMatchSnapshot()
  })

  it('carries the issues and the standing coverage figure', () => {
    const summary = renderSummary(failingScenario())
    expect(summary).toContain('### Issues')
    expect(summary).toContain('### Coverage')
    expect(summary).toContain('| Language | Coverage | Translated | Threshold | Status |')
  })

  it('shows the translated fraction, not only a percentage', () => {
    expect(renderSummary(thresholdScenario())).toContain('| 1 / 2 |')
  })

  it('notes annotations the cap discarded', () => {
    const input = { ...failingScenario(), annotationsDropped: 23 }
    expect(renderSummary(input)).toContain('23 annotations were not shown inline')
    expect(renderComment(input)).toContain('23 annotations not shown inline')
  })

  it('renders parse errors as their own kind of problem', () => {
    const rendered = renderParseErrors([
      Object.assign(new Error('invalid JSON at line 4, column 2'), {
        name: 'CatalogParseError',
        file: 'App/Broken.xcstrings',
        line: 4,
      }) as never,
    ])
    expect(rendered).toContain('could not read 1 file')
    expect(rendered).toContain('App/Broken.xcstrings')
    expect(rendered).toContain('not a translation gap')
  })
})

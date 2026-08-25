import { describe, expect, it } from 'vitest'
import { analyze } from '../src/core/analyze.js'
import { defaultConfig } from '../src/core/config.js'
import { loadCatalogs, type RevisionFiles } from '../src/core/load.js'
import { compareToBase } from '../src/core/ratchet.js'
import { belowThreshold } from '../src/core/ratchet.js'
import { DEFAULT_MAX_PER_LEVEL, planAnnotations } from '../src/report/annotations.js'
import { COMMENT_MARKER, isOurComment, renderComment, truncate } from '../src/report/comment.js'
import { renderParseErrors, renderSummary } from '../src/report/summary.js'
import {
  code,
  delta,
  groupLanguagesByIssues,
  percent,
  renderKeySections,
  renderLanguageCell,
  renderLanguageTable,
} from '../src/report/model.js'
import type { ReportInput } from '../src/report/model.js'
import type { Issue } from '../src/core/types.js'

const config = defaultConfig()

function memoryFiles(files: Record<string, string>, label = 'memory'): RevisionFiles {
  return {
    label,
    list: () => Object.keys(files),
    read: (path) => (files[path] === undefined ? undefined : Buffer.from(files[path], 'utf8')),
  }
}

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

/** A ratchet run mirroring the payment-flow example from the spec. */
function paymentScenario(): ReportInput {
  const base = {
    'App/Localizable.xcstrings': catalog({
      payment_save_card_title: { en: 'Save card', de: 'Karte', fr: 'Carte', ja: 'カード' },
      payment_cvv_hint: { en: 'CVV', de: 'CVV', fr: 'CVV', ja: 'CVV' },
    }),
  }
  const head = {
    'App/Localizable.xcstrings': catalog({
      payment_save_card_title: { en: 'Save card', de: 'Karte', fr: 'Carte', ja: null },
      payment_save_card_subtitle: { en: 'Save for later', de: 'Später', fr: null, ja: null },
      payment_cvv_hint: { en: 'CVV', de: 'CVV', fr: '', ja: null },
    }),
  }

  const headCatalogs = loadCatalogs(memoryFiles(head, 'head'), config).catalogs
  const comparison = compareToBase(headCatalogs, memoryFiles(base, 'origin/main'), config)

  return {
    mode: 'ratchet',
    passed: false,
    result: comparison.head,
    allIssues: comparison.head.issues,
    blocking: comparison.newIssues,
    comparison,
    baseRef: 'main',
  }
}

/** A clean PR sitting on top of a base branch that already has a backlog. */
function backlogScenario(): ReportInput {
  const shared = {
    old_a: { en: 'A', de: 'A', fr: null, ja: null },
    old_b: { en: 'B', de: 'B', fr: null, ja: null },
    old_empty: { en: 'C', de: '', fr: '', ja: '' },
  }
  const base = { 'App/Localizable.xcstrings': catalog(shared) }
  const head = {
    'App/Localizable.xcstrings': catalog({
      ...shared,
      brand_new: { en: 'New', de: 'Neu', fr: 'Nouveau', ja: '新規' },
    }),
  }
  const headCatalogs = loadCatalogs(memoryFiles(head, 'head'), config).catalogs
  const comparison = compareToBase(headCatalogs, memoryFiles(base, 'origin/main'), config)
  return {
    mode: 'ratchet',
    passed: true,
    result: comparison.head,
    allIssues: comparison.head.issues,
    blocking: comparison.newIssues,
    comparison,
    baseRef: 'main',
  }
}

function cleanScenario(): ReportInput {
  const files = {
    'App/Localizable.xcstrings': catalog({
      a: { en: 'A', de: 'A', fr: 'A' },
      b: { en: 'B', de: 'B', fr: 'B' },
    }),
  }
  const headCatalogs = loadCatalogs(memoryFiles(files, 'head'), config).catalogs
  const comparison = compareToBase(headCatalogs, memoryFiles(files, 'origin/main'), config)
  return {
    mode: 'ratchet',
    passed: true,
    result: comparison.head,
    allIssues: comparison.head.issues,
    blocking: comparison.newIssues,
    comparison,
    baseRef: 'main',
  }
}

function absoluteScenario(): ReportInput {
  const files = {
    'App/Localizable.xcstrings': catalog({
      a: { en: 'A', de: 'A', fr: 'A' },
      b: { en: 'B', de: 'B', fr: null },
    }),
  }
  const result = analyze(loadCatalogs(memoryFiles(files), config).catalogs, config)
  const shortfalls = belowThreshold(result.coverage, 100, config.required)
  return {
    mode: 'absolute',
    passed: false,
    result,
    allIssues: result.issues,
    blocking: result.issues,
    shortfalls,
    threshold: 100,
  }
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

  it('shows direction of travel', () => {
    expect(delta(100, 99.4)).toBe('🔻 0.6%')
    expect(delta(99.4, 100)).toBe('🔺 0.6%')
    expect(delta(100, 100)).toBe('—')
    expect(delta(undefined, 50)).toBe('new')
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
    const input = paymentScenario()
    const plan = planAnnotations(input.blocking)
    expect(plan.annotations.length).toBeGreaterThan(0)
    for (const annotation of plan.annotations) {
      expect(annotation.file).toBe('App/Localizable.xcstrings')
      expect(annotation.line).toBeGreaterThan(1)
      expect(annotation.title).toMatch(/^[A-Z][^:]+: \S/)
      expect(annotation.message).not.toBe('')
    }
  })

  it('titles each annotation with its issue class and key', () => {
    const input = paymentScenario()
    const titles = planAnnotations(input.blocking).annotations.map((a) => a.title)
    expect(titles).toContain('Missing translation: payment_save_card_subtitle')
    expect(titles).toContain('Empty translation: payment_cvv_hint')
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
    for (const input of [paymentScenario(), cleanScenario(), absoluteScenario()]) {
      expect(renderComment(input)).toContain(COMMENT_MARKER)
    }
  })

  it('recognises its own comment and no one else’s', () => {
    expect(isOurComment(renderComment(cleanScenario()))).toBe(true)
    expect(isOurComment('LGTM!')).toBe(false)
    expect(isOurComment(undefined)).toBe(false)
  })

  it('renders a failing ratchet report', () => {
    expect(renderComment(paymentScenario())).toMatchSnapshot()
  })

  it('renders a passing ratchet report', () => {
    expect(renderComment(cleanScenario())).toMatchSnapshot()
  })

  it('renders an absolute-mode report', () => {
    expect(renderComment(absoluteScenario())).toMatchSnapshot()
  })

  it('shows no percentages anywhere', () => {
    for (const input of [paymentScenario(), absoluteScenario()]) {
      expect(renderComment(input)).not.toMatch(/\d%/)
    }
  })

  it('keeps the detail collapsed so the summary reads first', () => {
    const body = renderComment(paymentScenario())
    expect(body).not.toContain('<details open>')
    expect(body.indexOf('| Languages |')).toBeLessThan(body.indexOf('<details>'))
  })

  it('offers the pre-existing backlog as an expandable section', () => {
    const input = backlogScenario()
    expect(input.blocking).toEqual([])
    expect(input.allIssues.length).toBeGreaterThan(0)

    const body = renderComment(input)
    // Still a pass: the backlog is context, not this PR's verdict.
    expect(body).toContain('**passed**')
    expect(body).toContain('No new localization issues')
    expect(body).toContain(
      `<details><summary><b>Pre-existing issues</b> · ${input.allIssues.length} — not introduced by this PR</summary>`,
    )
  })

  it('names the pre-existing keys, not just a count', () => {
    const body = renderComment(backlogScenario())
    expect(body).toContain('| `old_a` |')
    expect(body).toContain('**Missing translations** ·')
    expect(body).toContain('| Languages | Missing | Empty | Total |')
  })

  it('does not nest one collapsible block inside another', () => {
    const body = renderComment(backlogScenario())
    const opens = (body.match(/<details>/g) ?? []).length
    const closes = (body.match(/<\/details>/g) ?? []).length
    expect(opens).toBe(closes)
    // Exactly one block: the backlog. Its class sections render flat inside it.
    expect(opens).toBe(1)
  })

  it('omits the backlog section when there is no backlog', () => {
    const body = renderComment(cleanScenario())
    expect(body).not.toContain('Pre-existing')
    expect(body).not.toContain('<details>')
  })

  it('renders a passing report that carries a backlog', () => {
    expect(renderComment(backlogScenario())).toMatchSnapshot()
  })

  it('keeps the marker when the body has to be truncated', () => {
    const body = renderComment(paymentScenario())
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
  it('renders a failing ratchet report', () => {
    expect(renderSummary(paymentScenario())).toMatchSnapshot()
  })

  it('renders an absolute-mode report', () => {
    expect(renderSummary(absoluteScenario())).toMatchSnapshot()
  })

  it('separates new issues from pre-existing ones', () => {
    const summary = renderSummary(paymentScenario())
    expect(summary).toContain('New issues')
    expect(summary).toContain('Coverage')
  })

  it('notes annotations the cap discarded', () => {
    const input = { ...paymentScenario(), annotationsDropped: 23 }
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

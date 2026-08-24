import { describe, expect, it } from 'vitest'
import { analyze } from '../src/core/analyze.js'
import { defaultConfig } from '../src/core/config.js'
import { loadCatalogs, type RevisionFiles } from '../src/core/load.js'
import { compareToBase } from '../src/core/ratchet.js'
import { belowThreshold } from '../src/core/ratchet.js'
import { DEFAULT_MAX_PER_LEVEL, planAnnotations } from '../src/report/annotations.js'
import { COMMENT_MARKER, isOurComment, renderComment, truncate } from '../src/report/comment.js'
import { renderParseErrors, renderSummary } from '../src/report/summary.js'
import { code, delta, percent } from '../src/report/model.js'
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

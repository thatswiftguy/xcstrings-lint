import { describe, expect, it } from 'vitest'
import { analyze } from '../src/core/analyze.js'
import { compareIssues, issueIdentity, unifiedLanguages } from '../src/core/compare.js'
import { defaultConfig, type ResolvedConfig } from '../src/core/config.js'
import { parseXcstrings } from '../src/core/parse/xcstrings.js'
import { buildReport } from '../src/lint.js'
import { renderComment } from '../src/report/comment.js'
import { carriedIssues, warningIssues } from '../src/report/model.js'
import type { Issue } from '../src/core/types.js'

/**
 * The base-branch comparison. It never changes *what* is checked -- the whole
 * repository, always -- only which of the findings a reviewer is answerable for.
 */

const config = defaultConfig()

type Cell = string | null
const catalog = (entries: Record<string, Record<string, Cell>>): string => {
  const strings: Record<string, unknown> = {}
  for (const [key, langs] of Object.entries(entries)) {
    const localizations: Record<string, unknown> = {}
    for (const [language, value] of Object.entries(langs)) {
      if (value === null) continue
      localizations[language] = { stringUnit: { state: 'translated', value } }
    }
    strings[key] = { extractionState: 'manual', localizations }
  }
  return JSON.stringify({ sourceLanguage: 'en', strings }, null, 2)
}

interface Sides {
  base: Record<string, Record<string, Cell>>
  head: Record<string, Record<string, Cell>>
}

function compare(sides: Sides, resolved: ResolvedConfig = config) {
  const baseCatalogs = [parseXcstrings('App/L.xcstrings', catalog(sides.base))]
  const headCatalogs = [parseXcstrings('App/L.xcstrings', catalog(sides.head))]
  const languages = unifiedLanguages(headCatalogs, baseCatalogs)
  const head = analyze(headCatalogs, resolved, { languages })
  const base = analyze(baseCatalogs, resolved, { languages })
  return {
    head,
    comparison: compareIssues(head, base, { baseLabel: 'origin/main' }),
  }
}

const keysOf = (issues: Issue[]) => [...new Set(issues.map((i) => i.key))].sort()

describe('what counts as new', () => {
  it('separates what this change introduced from what was already there', () => {
    const { comparison } = compare({
      base: { old_gap: { en: 'A', de: null }, kept: { en: 'B', de: 'Be' } },
      head: {
        old_gap: { en: 'A', de: null },
        kept: { en: 'B', de: 'Be' },
        fresh_gap: { en: 'C', de: null },
      },
    })
    expect(keysOf(comparison.newIssues)).toEqual(['fresh_gap'])
    expect(keysOf(comparison.preExisting)).toEqual(['old_gap'])
  })

  it('credits what this change fixed', () => {
    const { comparison } = compare({
      base: { a: { en: 'A', de: null } },
      head: { a: { en: 'A', de: 'Ah' } },
    })
    expect(keysOf(comparison.fixed)).toEqual(['a'])
    expect(comparison.newIssues).toEqual([])
  })

  it('does not call a state change a fresh regression', () => {
    // `new` and `empty` are two states of the same untranslated string. Moving
    // between them must not read as a newly introduced problem.
    const base = { a: { en: 'A', de: '' } }
    const { comparison } = compare({ base, head: base })
    expect(comparison.newIssues).toEqual([])
    expect(keysOf(comparison.preExisting)).toEqual(['a'])
  })

  it('gives each structural class its own identity', () => {
    const missing: Issue = {
      class: 'missing',
      severity: 'error',
      catalog: 'a',
      key: 'k',
      language: 'de',
      loc: { file: 'a', line: 1 },
      message: '',
    }
    expect(issueIdentity({ ...missing, class: 'empty' })).toBe(issueIdentity(missing))
    expect(issueIdentity({ ...missing, class: 'formatSpecifier' })).not.toBe(issueIdentity(missing))
    expect(issueIdentity({ ...missing, class: 'pluralCoverage' })).not.toBe(
      issueIdentity({ ...missing, class: 'formatSpecifier' }),
    )
  })

  it('assesses both sides against the same language set', () => {
    // Deleting the last German string must not make German vanish from head's
    // discovered set and read as "everything fixed".
    const { comparison } = compare({
      base: { a: { en: 'A', de: 'Ah' }, b: { en: 'B', de: 'Be' } },
      head: { a: { en: 'A' }, b: { en: 'B' } },
    })
    expect(keysOf(comparison.newIssues)).toEqual(['a', 'b'])
    expect(comparison.fixed).toEqual([])
  })
})

describe('what blocks', () => {
  // `done` carries the German translation that makes `de` a language this
  // catalog has at all; without it there is no target to be missing from.
  const sides: Sides = {
    base: { done: { en: 'D', de: 'De' }, old_gap: { en: 'A', de: null } },
    head: {
      done: { en: 'D', de: 'De' },
      old_gap: { en: 'A', de: null },
      fresh_gap: { en: 'C', de: null },
    },
  }

  const report = (mode: 'full' | 'ratchet') => {
    const { head, comparison } = compare(sides)
    return buildReport(head, { config, mode, threshold: 100, filesScanned: 1, comparison })
  }

  it('full mode blocks on everything, however old', () => {
    const input = report('full')
    expect(keysOf(input.blocking)).toEqual(['fresh_gap', 'old_gap'])
    expect(input.passed).toBe(false)
  })

  it('ratchet mode blocks only on what this change introduced', () => {
    const input = report('ratchet')
    expect(keysOf(input.blocking)).toEqual(['fresh_gap'])
    expect(keysOf(input.preExisting)).toEqual(['old_gap'])
  })

  it('ratchet mode passes a change that adds nothing new', () => {
    const { head, comparison } = compare({ base: sides.base, head: sides.base })
    const input = buildReport(head, {
      config,
      mode: 'ratchet',
      threshold: 100,
      filesScanned: 1,
      comparison,
    })
    expect(input.blocking).toEqual([])
    expect(input.passed).toBe(true)
    // The backlog is still reported -- it is just not this change's verdict.
    expect(input.preExisting.length).toBeGreaterThan(0)
  })

  it('ratchet mode does not apply the coverage threshold', () => {
    // Adding ten translated strings and one untranslated one moves the
    // percentage up while shipping an untranslated string.
    const { head, comparison } = compare({ base: sides.base, head: sides.base })
    const input = buildReport(head, {
      config,
      mode: 'ratchet',
      threshold: 100,
      filesScanned: 1,
      comparison,
    })
    expect(input.shortfalls).toEqual([])
    expect(input.result.coverage.de!.percent).toBe(50)
  })

  it('never files a pre-existing error under warnings', () => {
    const input = report('ratchet')
    expect(warningIssues(input).every((issue) => issue.severity === 'warn')).toBe(true)
    expect(keysOf(input.preExisting)).toEqual(['old_gap'])
  })

  it('counts non-blocking issues honestly when they are all pre-existing', () => {
    // Regression: `warnings` used to mean "non-blocking AND not pre-existing",
    // so a pull request that touched no catalogs reported zero warnings while
    // six real ones sat in the report. CI caught it; the unit suite did not,
    // because every fixture here had at least one brand new warning.
    const unchanged = {
      done: { en: 'D', de: 'De' },
      // Only a German entry: an orphan key, which is a warning, not an error.
      orphan: { en: null, de: 'Weg' },
    }
    const { head, comparison } = compare({ base: unchanged, head: unchanged })
    const input = buildReport(head, {
      config,
      mode: 'full',
      threshold: 100,
      filesScanned: 1,
      comparison,
    })

    expect(keysOf(input.nonBlocking)).toEqual(['orphan'])
    expect(keysOf(input.preExisting)).toEqual(['orphan'])
    // The same issue is in both partitions, and neither count hides it.
    expect(input.nonBlocking).toHaveLength(1)
    // It renders under "pre-existing", not "warnings" -- a display choice that
    // must not leak back into the counts.
    expect(keysOf(carriedIssues(input))).toEqual(['orphan'])
    expect(warningIssues(input)).toEqual([])
  })

  it('counts the backlog honestly in both modes', () => {
    // Full mode blocks on the old gap, but the base branch still had it. A
    // pre-existing count of zero there would simply be untrue.
    expect(keysOf(report('full').preExisting)).toEqual(['old_gap'])
    expect(keysOf(report('ratchet').preExisting)).toEqual(['old_gap'])
  })

  it('lists the backlog separately only when it is not already blocking', () => {
    // Printing an old problem again under "not introduced by this change" when
    // the run just failed on it reads as an excuse.
    expect(carriedIssues(report('full'))).toEqual([])
    expect(keysOf(carriedIssues(report('ratchet')))).toEqual(['old_gap'])
  })
})

describe('the report tells you which are yours', () => {
  const sides: Sides = {
    base: { done: { en: 'D', de: 'De' }, old_gap: { en: 'A', de: null } },
    head: {
      done: { en: 'D', de: 'De' },
      old_gap: { en: 'A', de: null },
      fresh_gap: { en: 'C', de: null },
    },
  }

  it('names the base branch and keeps the backlog collapsed', () => {
    const { head, comparison } = compare(sides)
    const body = renderComment(
      buildReport(head, { config, mode: 'ratchet', threshold: 100, filesScanned: 1, comparison }),
    )
    expect(body).toContain('**1 new issue** vs `origin/main`')
    expect(body).toContain('<b>Pre-existing issues</b> · 1 — not introduced by this change')
    expect(body).toContain('gate: new issues only')
  })

  it('still shows the split in full mode, where everything blocks', () => {
    const { head, comparison } = compare(sides)
    const input = buildReport(head, {
      config,
      mode: 'full',
      threshold: 100,
      filesScanned: 1,
      comparison,
    })
    expect(input.comparedToBase).toBe(true)
    expect(keysOf(input.newIssues)).toEqual(['fresh_gap'])
    expect(renderComment(input)).toContain('**2 issues**')
  })

  it('says nothing about a base branch when there was none', () => {
    const { head } = compare(sides)
    const input = buildReport(head, { config, mode: 'full', threshold: 100, filesScanned: 1 })
    expect(input.comparedToBase).toBe(false)
    expect(input.newIssues).toEqual([])
    expect(input.preExisting).toEqual([])
    expect(renderComment(input)).not.toContain('Pre-existing')
  })
})

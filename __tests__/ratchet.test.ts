import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { defaultConfig } from '../src/core/config.js'
import { loadCatalogs, workingTreeFiles, type RevisionFiles } from '../src/core/load.js'
import {
  BaseRefError,
  baseRevisionFiles,
  belowThreshold,
  compareToBase,
  issueIdentity,
  resolveBaseRevision,
} from '../src/core/ratchet.js'
import type { Issue } from '../src/core/types.js'

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** An in-memory revision, so the ratchet logic tests without touching git. */
function memoryFiles(files: Record<string, string>, label = 'memory'): RevisionFiles {
  return {
    label,
    list: () => Object.keys(files),
    read: (path) => (files[path] === undefined ? undefined : Buffer.from(files[path], 'utf8')),
  }
}

type Entry = { de?: string | null; state?: string }

/** Build a minimal `.xcstrings` where every key has English and optional German. */
function catalog(entries: Record<string, Entry>): string {
  const strings: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(entries)) {
    const localizations: Record<string, unknown> = {
      en: { stringUnit: { state: 'translated', value: `EN ${key}` } },
    }
    if (entry.de !== undefined && entry.de !== null) {
      localizations.de = {
        stringUnit: { state: entry.state ?? 'translated', value: entry.de },
      }
    }
    strings[key] = { extractionState: 'manual', localizations }
  }
  return JSON.stringify({ sourceLanguage: 'en', strings, version: '1.0' }, null, 2)
}

const config = defaultConfig()

function compare(base: Record<string, string>, head: Record<string, string>) {
  const headCatalogs = loadCatalogs(memoryFiles(head, 'head'), config).catalogs
  return compareToBase(headCatalogs, memoryFiles(base, 'origin/main'), config)
}

const keysOf = (issues: Issue[]) => issues.map((i) => `${i.key}/${i.language ?? '-'}`).sort()

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

describe('issue identity', () => {
  const base: Issue = {
    class: 'missing',
    severity: 'error',
    catalog: 'App/L.xcstrings',
    key: 'k',
    language: 'de',
    loc: { file: 'App/L.xcstrings', line: 3 },
    message: '',
  }

  it('treats every state class as the same pair', () => {
    const states = ['missing', 'empty', 'new', 'needsReview', 'stale'] as const
    const identities = new Set(states.map((cls) => issueIdentity({ ...base, class: cls })))
    expect(identities.size).toBe(1)
  })

  it('keeps structural checks distinct from state and from each other', () => {
    const identities = new Set(
      (['missing', 'formatSpecifier', 'pluralCoverage'] as const).map((cls) =>
        issueIdentity({ ...base, class: cls }),
      ),
    )
    expect(identities.size).toBe(3)
  })

  it('separates languages, keys and catalogs', () => {
    expect(issueIdentity(base)).not.toBe(issueIdentity({ ...base, language: 'fr' }))
    expect(issueIdentity(base)).not.toBe(issueIdentity({ ...base, key: 'other' }))
    expect(issueIdentity(base)).not.toBe(issueIdentity({ ...base, catalog: 'B/L.xcstrings' }))
  })

  it('cannot be confused by separators inside a key', () => {
    expect(issueIdentity({ ...base, key: 'a', language: 'b/c' })).not.toBe(
      issueIdentity({ ...base, key: 'a/b', language: 'c' }),
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Comparison                                                                  */
/* -------------------------------------------------------------------------- */

describe('comparing head against base', () => {
  it('says nothing when nothing changed', () => {
    const files = { 'App/L.xcstrings': catalog({ a: { de: 'A' }, b: { de: null } }) }
    const { newIssues, fixedIssues } = compare(files, files)
    expect(newIssues).toEqual([])
    expect(fixedIssues).toEqual([])
  })

  it('flags a newly added untranslated key', () => {
    const { newIssues } = compare(
      { 'App/L.xcstrings': catalog({ a: { de: 'A' } }) },
      { 'App/L.xcstrings': catalog({ a: { de: 'A' }, b: { de: null } }) },
    )
    expect(keysOf(newIssues)).toEqual(['b/de'])
    expect(newIssues[0]!.class).toBe('missing')
  })

  it('leaves a pre-existing gap alone -- that is not this PR to fix', () => {
    const { newIssues } = compare(
      { 'App/L.xcstrings': catalog({ a: { de: null } }) },
      { 'App/L.xcstrings': catalog({ a: { de: null }, b: { de: 'B' } }) },
    )
    expect(newIssues).toEqual([])
  })

  it('flags a translation that was removed', () => {
    const { newIssues } = compare(
      { 'App/L.xcstrings': catalog({ a: { de: 'A' } }) },
      { 'App/L.xcstrings': catalog({ a: { de: null } }) },
    )
    expect(keysOf(newIssues)).toEqual(['a/de'])
  })

  it('does not re-flag a broken pair that merely changed how it is broken', () => {
    // `new` -> `empty` is the same untranslated string wearing a different hat.
    const { newIssues } = compare(
      { 'App/L.xcstrings': catalog({ a: { de: 'A', state: 'new' } }) },
      { 'App/L.xcstrings': catalog({ a: { de: '' } }) },
    )
    expect(newIssues).toEqual([])
  })

  it('credits a fixed translation', () => {
    const { fixedIssues, newIssues } = compare(
      { 'App/L.xcstrings': catalog({ a: { de: null } }) },
      { 'App/L.xcstrings': catalog({ a: { de: 'A' } }) },
    )
    expect(newIssues).toEqual([])
    expect(keysOf(fixedIssues)).toEqual(['a/de'])
  })

  it('flags everything in a newly added catalog', () => {
    const { newIssues } = compare(
      { 'App/L.xcstrings': catalog({ a: { de: 'A' } }) },
      {
        'App/L.xcstrings': catalog({ a: { de: 'A' } }),
        'App/New.xcstrings': catalog({ x: { de: null }, y: { de: null } }),
      },
    )
    expect(keysOf(newIssues)).toEqual(['x/de', 'y/de'])
  })

  it('treats a deleted catalog as fixed, not as a regression', () => {
    const { newIssues, fixedIssues } = compare(
      {
        'App/L.xcstrings': catalog({ a: { de: 'A' } }),
        'App/Old.xcstrings': catalog({ x: { de: null } }),
      },
      { 'App/L.xcstrings': catalog({ a: { de: 'A' } }) },
    )
    expect(newIssues).toEqual([])
    expect(keysOf(fixedIssues)).toEqual(['x/de'])
  })

  it('catches a new format-specifier break in an already-untranslated language', () => {
    const base = {
      'App/L.xcstrings': JSON.stringify({
        sourceLanguage: 'en',
        strings: {
          count: {
            localizations: {
              en: { stringUnit: { state: 'translated', value: 'You have %lld items' } },
              de: { stringUnit: { state: 'needs_review', value: 'Sie haben %lld Artikel' } },
            },
          },
        },
      }),
    }
    const head = {
      'App/L.xcstrings': JSON.stringify({
        sourceLanguage: 'en',
        strings: {
          count: {
            localizations: {
              en: { stringUnit: { state: 'translated', value: 'You have %lld items' } },
              de: { stringUnit: { state: 'needs_review', value: 'Sie haben %@ Artikel' } },
            },
          },
        },
      }),
    }
    const { newIssues } = compare(base, head)
    expect(newIssues.map((i) => i.class)).toEqual(['formatSpecifier'])
  })

  /**
   * The reason the gate is a set difference and not a percentage.
   */
  it('fails a PR that raises overall coverage while adding an untranslated key', () => {
    const base = { 'App/L.xcstrings': catalog({ a: { de: null } }) }
    const headEntries: Record<string, Entry> = { a: { de: null }, k: { de: null } }
    for (let i = 0; i < 9; i++) headEntries[`b${i}`] = { de: `B${i}` }
    const head = { 'App/L.xcstrings': catalog(headEntries) }

    const comparison = compare(base, head)
    const { newIssues, baseCoverage } = comparison

    // Coverage went up, so a percentage-decrease gate would wave this through.
    expect(baseCoverage.de!.percent).toBe(0)
    expect(comparison.head.coverage.de!.percent).toBeGreaterThan(baseCoverage.de!.percent)

    // The new-issue gate catches the one string this PR actually broke.
    expect(keysOf(newIssues)).toEqual(['k/de'])
  })

  it('reports base-side parse failures rather than treating base as clean', () => {
    const { baseErrors, newIssues } = compare(
      { 'App/L.xcstrings': '{ not json' },
      { 'App/L.xcstrings': catalog({ a: { de: null }, b: { de: 'B' } }) },
    )
    expect(baseErrors).toHaveLength(1)
    expect(baseErrors[0]!.file).toBe('App/L.xcstrings')
    // With base unreadable, every head issue looks new -- which is why the
    // caller must treat baseErrors as fatal rather than trusting this.
    expect(keysOf(newIssues)).toEqual(['a/de'])
  })
})

/* -------------------------------------------------------------------------- */
/* Absolute mode                                                               */
/* -------------------------------------------------------------------------- */

describe('absolute threshold', () => {
  const coverage = {
    de: { language: 'de', translatable: 10, translated: 10, percent: 100 },
    fr: { language: 'fr', translatable: 10, translated: 9, percent: 90 },
    ja: { language: 'ja', translatable: 10, translated: 5, percent: 50 },
  }

  it('lists languages under the bar, worst first', () => {
    expect(belowThreshold(coverage, 100).map((s) => s.language)).toEqual(['ja', 'fr'])
  })

  it('accepts everything at a lower bar', () => {
    expect(belowThreshold(coverage, 50)).toEqual([])
  })

  it('treats a required language with no coverage at all as zero', () => {
    expect(belowThreshold(coverage, 100, ['de', 'ko'])).toEqual([
      { language: 'ko', percent: 0, threshold: 100 },
    ])
  })
})

/* -------------------------------------------------------------------------- */
/* Git integration                                                             */
/* -------------------------------------------------------------------------- */

describe('resolving the base revision', () => {
  const repos: string[] = []
  afterAll(() => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
  })

  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const write = (repo: string, path: string, content: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }

  /** A repo with `main`, then a `feature` branch that adds an untranslated key. */
  function buildRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), 'xcstrings-lint-'))
    repos.push(repo)
    run(repo, 'init', '-b', 'main', '-q')
    run(repo, 'config', 'user.email', 'test@example.com')
    run(repo, 'config', 'user.name', 'Test')
    run(repo, 'config', 'commit.gpgsign', 'false')

    write(repo, 'App/L.xcstrings', catalog({ a: { de: 'A' } }))
    run(repo, 'add', '.')
    run(repo, 'commit', '-q', '-m', 'base')

    run(repo, 'checkout', '-q', '-b', 'feature')
    write(repo, 'App/L.xcstrings', catalog({ a: { de: 'A' }, b: { de: null } }))
    run(repo, 'add', '.')
    run(repo, 'commit', '-q', '-m', 'add an untranslated key')

    // Move main on independently, so a base-tip comparison would be unfair.
    run(repo, 'checkout', '-q', 'main')
    write(repo, 'App/Other.xcstrings', catalog({ z: { de: null } }))
    run(repo, 'add', '.')
    run(repo, 'commit', '-q', '-m', 'unrelated work on main')
    run(repo, 'checkout', '-q', 'feature')

    return repo
  }

  it('resolves a local branch name to the merge base', () => {
    const repo = buildRepo()
    const revision = resolveBaseRevision({ cwd: repo, baseRef: 'main' })
    const expected = run(repo, 'merge-base', 'main', 'HEAD').trim()
    expect(revision).toBe(expected)
  })

  it('blames only this branch, not work that landed on main separately', () => {
    const repo = buildRepo()
    const revision = resolveBaseRevision({ cwd: repo, baseRef: 'main' })
    const headCatalogs = loadCatalogs(workingTreeFiles(repo, config), config).catalogs
    const { newIssues } = compareToBase(headCatalogs, baseRevisionFiles(revision, repo), config)

    // `b` is this branch's doing. `z` never existed on this branch at all.
    expect(keysOf(newIssues)).toEqual(['b/de'])
  })

  it('explains how to fix a missing base ref instead of leaking a git error', () => {
    const repo = buildRepo()
    let thrown: unknown
    try {
      resolveBaseRevision({ cwd: repo, baseRef: 'no-such-branch' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(BaseRefError)
    const message = (thrown as BaseRefError).message
    expect(message).toContain('Could not resolve the base branch "no-such-branch"')
    expect(message).toContain('fetch-depth: 0')
    expect(message).toContain('mode: absolute')
    expect(message).not.toMatch(/fatal:|ENOENT|at Object\./)
  })

  it('rejects an empty base ref with the same guidance', () => {
    const repo = buildRepo()
    expect(() => resolveBaseRevision({ cwd: repo, baseRef: '' })).toThrowError(
      /No base branch to compare against/,
    )
  })

  it('reads base files without disturbing the working tree', () => {
    const repo = buildRepo()
    const before = run(repo, 'status', '--porcelain')
    const revision = resolveBaseRevision({ cwd: repo, baseRef: 'main' })
    const files = baseRevisionFiles(revision, repo)
    expect(files.list()).toContain('App/L.xcstrings')
    expect(files.read('App/L.xcstrings')!.toString('utf8')).toContain('"a"')
    expect(files.read('App/Nope.xcstrings')).toBeUndefined()
    expect(run(repo, 'status', '--porcelain')).toBe(before)
  })
})

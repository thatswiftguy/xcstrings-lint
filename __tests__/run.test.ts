import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError } from '../src/core/config.js'
import { BaseRefError } from '../src/core/ratchet.js'
import { exitCodeFor, run } from '../src/run.js'
import { fixturePath } from './helpers.js'

/**
 * `run()` is the whole check. `main.ts` only renders its result and maps the
 * exit code, so this is where the behaviour that decides pass or fail is
 * pinned down.
 */

const CLEAN = fixturePath('project-clean')
const BROKEN = fixturePath('project-broken')

/** A throwaway project directory, cleaned up after the test. */
function project(files: Record<string, string>, body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'xcstrings-lint-'))
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, content)
    }
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const catalog = (strings: Record<string, unknown>): string =>
  JSON.stringify({ sourceLanguage: 'en', strings, version: '1.0' })

const unit = (state: string, value: string) => ({ stringUnit: { state, value } })

describe('exit codes', () => {
  it('0 when a project is clean', () => {
    const result = run({ cwd: CLEAN, configPath: '.xcstrings-lint.yml', mode: 'absolute' })
    expect(result.input.passed).toBe(true)
    expect(exitCodeFor(result)).toBe(0)
  })

  it('1 when there are blocking issues', () => {
    const result = run({ cwd: BROKEN, configPath: '.xcstrings-lint.yml', mode: 'absolute' })
    expect(result.input.passed).toBe(false)
    expect(exitCodeFor(result)).toBe(1)
  })

  it('2 when a catalog cannot be parsed, rather than 1', () => {
    project({ 'App/L.xcstrings': '{ not json' }, (dir) => {
      const result = run({ cwd: dir, configPath: '.xcstrings-lint.yml', mode: 'absolute' })
      expect(result.parseErrors).toHaveLength(1)
      expect(result.parseErrors[0]!.message).toMatch(/invalid JSON/)
      // An unreadable file must never be reported as fully covered.
      expect(exitCodeFor(result)).toBe(2)
    })
  })

  it('reports a parse error per file instead of stopping at the first', () => {
    project(
      {
        'App/A.xcstrings': '{ not json',
        'App/B.xcstrings': '{ also not json',
        'App/C.xcstrings': catalog({ k: { localizations: { en: unit('translated', 'K') } } }),
      },
      (dir) => {
        const result = run({ cwd: dir, configPath: '.xcstrings-lint.yml', mode: 'absolute' })
        expect(result.parseErrors.map((e) => e.file).sort()).toEqual([
          'App/A.xcstrings',
          'App/B.xcstrings',
        ])
      },
    )
  })
})

describe('configuration errors surface as ConfigError', () => {
  it('when a named config file is missing', () => {
    expect(() =>
      run({ cwd: CLEAN, configPath: 'nope.yml', configExplicit: true, mode: 'absolute' }),
    ).toThrowError(ConfigError)
  })

  it('when the config file is invalid', () => {
    project({ '.xcstrings-lint.yml': 'pluralCoverage: loud\n' }, (dir) => {
      let thrown: unknown
      try {
        run({
          cwd: dir,
          configPath: join(dir, '.xcstrings-lint.yml'),
          configExplicit: true,
          mode: 'absolute',
        })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ConfigError)
      expect((thrown as ConfigError).message).toMatch(/Expected 'error' \| 'warn' \| 'off'/)
      expect((thrown as ConfigError).message).not.toMatch(/ {4}at /)
    })
  })

  it('when ratchet mode has no base ref, with actionable guidance', () => {
    let thrown: unknown
    try {
      run({ cwd: CLEAN, configPath: '.xcstrings-lint.yml', mode: 'ratchet', baseRef: '' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(BaseRefError)
    expect((thrown as BaseRefError).message).toContain('fetch-depth: 0')
    expect((thrown as BaseRefError).message).toContain('mode: absolute')
  })
})

describe('absolute mode', () => {
  it('fails on a format specifier crash even at 100% coverage', () => {
    project(
      {
        'App/L.xcstrings': catalog({
          count: {
            localizations: {
              en: unit('translated', 'You have %lld items'),
              de: unit('translated', 'Sie haben %@ Artikel'),
            },
          },
        }),
      },
      (dir) => {
        const result = run({ cwd: dir, configPath: '.xcstrings-lint.yml', mode: 'absolute' })
        // Nothing is untranslated, so a coverage gate alone would pass this.
        expect(result.input.result.coverage.de!.percent).toBe(100)
        expect(result.input.shortfalls).toEqual([])
        expect(result.input.passed).toBe(false)
        expect(exitCodeFor(result)).toBe(1)
      },
    )
  })

  it('passes when only warnings remain', () => {
    project(
      {
        'App/L.xcstrings': catalog({
          k: {
            localizations: {
              en: unit('translated', 'Cancel'),
              de: unit('needs_review', 'Abbrechen'),
            },
          },
        }),
      },
      (dir) => {
        const result = run({ cwd: dir, configPath: '.xcstrings-lint.yml', mode: 'absolute' })
        expect(result.input.allIssues.map((i) => i.class)).toEqual(['needsReview'])
        expect(result.input.passed).toBe(true)
        expect(exitCodeFor(result)).toBe(0)
      },
    )
  })

  it('honours the threshold', () => {
    project(
      {
        'App/L.xcstrings': catalog({
          a: { localizations: { en: unit('translated', 'A'), de: unit('translated', 'A') } },
          b: { localizations: { en: unit('translated', 'B') } },
        }),
      },
      (dir) => {
        const strict = run({ cwd: dir, configPath: 'x.yml', mode: 'absolute', threshold: 100 })
        expect(strict.input.shortfalls?.map((s) => s.language)).toEqual(['de'])

        const lenient = run({ cwd: dir, configPath: 'x.yml', mode: 'absolute', threshold: 50 })
        expect(lenient.input.shortfalls).toEqual([])
        // The missing string is still an error, so the run still fails.
        expect(lenient.input.passed).toBe(false)
      },
    )
  })
})

describe('configuration is applied', () => {
  it('reads a config file found on disk', () => {
    project(
      {
        '.xcstrings-lint.yml': "ignore:\n  patterns: ['debug_*']\n",
        'App/L.xcstrings': catalog({
          debug_thing: { localizations: { en: unit('translated', 'X') } },
          real_thing: { localizations: { en: unit('translated', 'Y') } },
          keeper: {
            localizations: { en: unit('translated', 'Z'), de: unit('translated', 'Z') },
          },
        }),
      },
      (dir) => {
        const result = run({
          cwd: dir,
          configPath: join(dir, '.xcstrings-lint.yml'),
          configExplicit: true,
          mode: 'absolute',
        })
        expect(result.config.source).toBe(join(dir, '.xcstrings-lint.yml'))
        const keys = result.input.allIssues.map((i) => i.key)
        expect(keys).toContain('real_thing')
        expect(keys).not.toContain('debug_thing')
      },
    )
  })

  it('runs with no config file at all', () => {
    project(
      {
        'App/L.xcstrings': catalog({
          a: { localizations: { en: unit('translated', 'A'), de: unit('translated', 'A') } },
        }),
      },
      (dir) => {
        const result = run({ cwd: dir, configPath: '.xcstrings-lint.yml', mode: 'absolute' })
        expect(result.config.source).toBeUndefined()
        expect(result.input.passed).toBe(true)
      },
    )
  })

  it('never walks vendored directories', () => {
    project(
      {
        'App/L.xcstrings': catalog({
          a: { localizations: { en: unit('translated', 'A'), de: unit('translated', 'A') } },
        }),
        'Pods/Lib/L.xcstrings': catalog({ b: { localizations: { en: unit('translated', 'B') } } }),
        'node_modules/x/L.xcstrings': '{ not json',
      },
      (dir) => {
        const result = run({ cwd: dir, configPath: '.xcstrings-lint.yml', mode: 'absolute' })
        expect(result.input.result.catalogs.map((c) => c.path)).toEqual(['App/L.xcstrings'])
        expect(result.parseErrors).toEqual([])
        expect(result.input.passed).toBe(true)
      },
    )
  })
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError } from '../src/core/config.js'
import { exitCodeFor, lint } from '../src/lint.js'
import { fixturePath } from './helpers.js'

/**
 * `lint()` is the whole check. `main.ts` only renders its result and maps the
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

const run = (cwd: string, options: Partial<Parameters<typeof lint>[0]> = {}) =>
  lint({ cwd, configPath: '.xcstrings-lint.yml', ...options })

describe('exit codes', () => {
  it('0 when a project is clean', () => {
    const result = run(CLEAN)
    expect(result.report.passed).toBe(true)
    expect(exitCodeFor(result)).toBe(0)
  })

  it('1 when there are blocking issues', () => {
    const result = run(BROKEN)
    expect(result.report.passed).toBe(false)
    expect(exitCodeFor(result)).toBe(1)
  })

  it('2 when a catalog cannot be parsed, rather than 1', () => {
    project({ 'App/L.xcstrings': '{ not json' }, (dir) => {
      const result = run(dir)
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
        const result = run(dir)
        expect(result.parseErrors.map((e) => e.file).sort()).toEqual([
          'App/A.xcstrings',
          'App/B.xcstrings',
        ])
      },
    )
  })
})

describe('the whole repository is the scope', () => {
  it('checks every catalog it finds, not a diff', () => {
    const result = run(BROKEN)
    expect(result.report.result.catalogs.map((c) => c.path).sort()).toEqual([
      'App/Counts.xcstrings',
      'App/Hygiene.xcstrings',
      'App/Localizable.xcstrings',
      'App/Payments.xcstrings',
    ])
    expect(result.report.filesScanned).toBe(4)
  })

  it('finds every class of problem in one pass', () => {
    const classes = new Set(run(BROKEN).report.issues.map((issue) => issue.class))
    expect([...classes].sort()).toEqual([
      'duplicateKey',
      'duplicateValue',
      'empty',
      'formatSpecifier',
      'missing',
      'needsReview',
      'new',
      'orphanKey',
      'pluralCoverage',
      'stale',
    ])
  })

  it('refuses to report a pass when the globs matched nothing', () => {
    project({ 'README.md': 'no catalogs here' }, (dir) => {
      let thrown: unknown
      try {
        run(dir)
      } catch (error) {
        thrown = error
      }
      // Silently passing is the worst possible outcome: the check looks green
      // and is doing nothing at all.
      expect(thrown).toBeInstanceOf(ConfigError)
      expect((thrown as ConfigError).message).toMatch(/no catalog files matched/)
      expect((thrown as ConfigError).message).toContain('**/*.xcstrings')
    })
  })
})

describe('configuration errors surface as ConfigError', () => {
  it('when a named config file is missing', () => {
    expect(() => run(CLEAN, { configPath: 'nope.yml', configExplicit: true })).toThrowError(
      ConfigError,
    )
  })

  it('when the config file is invalid', () => {
    project({ '.xcstrings-lint.yml': 'pluralCoverage: loud\n' }, (dir) => {
      let thrown: unknown
      try {
        run(dir, { configPath: join(dir, '.xcstrings-lint.yml'), configExplicit: true })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ConfigError)
      expect((thrown as ConfigError).message).toMatch(/Expected 'error' \| 'warn' \| 'off'/)
      expect((thrown as ConfigError).message).not.toMatch(/ {4}at /)
    })
  })
})

describe('the verdict', () => {
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
        const result = run(dir)
        // Nothing is untranslated, so a coverage gate alone would pass this.
        expect(result.report.result.coverage.de!.percent).toBe(100)
        expect(result.report.shortfalls).toEqual([])
        expect(result.report.passed).toBe(false)
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
        const result = run(dir)
        expect(result.report.warnings.map((i) => i.class)).toEqual(['needsReview'])
        expect(result.report.errors).toEqual([])
        expect(result.report.passed).toBe(true)
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
        const strict = run(dir, { threshold: 100 })
        expect(strict.report.shortfalls.map((s) => s.language)).toEqual(['de'])

        const lenient = run(dir, { threshold: 50 })
        expect(lenient.report.shortfalls).toEqual([])
        // The missing string is still an error, so the run still fails.
        expect(lenient.report.passed).toBe(false)
      },
    )
  })

  it('splits issues into the blocking ones and the rest', () => {
    const { report } = run(BROKEN)
    expect(report.errors.every((i) => i.severity === 'error')).toBe(true)
    expect(report.warnings.every((i) => i.severity === 'warn')).toBe(true)
    expect(report.errors.length + report.warnings.length).toBe(report.issues.length)
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
        const result = run(dir, {
          configPath: join(dir, '.xcstrings-lint.yml'),
          configExplicit: true,
        })
        expect(result.config.source).toBe(join(dir, '.xcstrings-lint.yml'))
        const keys = result.report.issues.map((i) => i.key)
        expect(keys).toContain('real_thing')
        expect(keys).not.toContain('debug_thing')
      },
    )
  })

  it('runs with no config file at all', () => {
    project(
      {
        'App/L.xcstrings': catalog({
          a: { localizations: { en: unit('translated', 'A'), de: unit('translated', 'Ah') } },
        }),
      },
      (dir) => {
        const result = run(dir)
        expect(result.config.source).toBeUndefined()
        expect(result.report.passed).toBe(true)
      },
    )
  })

  it('never walks vendored directories', () => {
    project(
      {
        'App/L.xcstrings': catalog({
          a: { localizations: { en: unit('translated', 'A'), de: unit('translated', 'Ah') } },
        }),
        'Pods/Lib/L.xcstrings': catalog({ b: { localizations: { en: unit('translated', 'B') } } }),
        'node_modules/x/L.xcstrings': '{ not json',
      },
      (dir) => {
        const result = run(dir)
        expect(result.report.result.catalogs.map((c) => c.path)).toEqual(['App/L.xcstrings'])
        expect(result.parseErrors).toEqual([])
        expect(result.report.passed).toBe(true)
      },
    )
  })

  it('gates on a language list that includes the source language', () => {
    // Regression: `required` naming the source language used to report it at
    // 0% coverage, because a source language is never a translation target --
    // so a fully translated project failed forever.
    project(
      {
        '.xcstrings-lint.yml': 'required: [en, de]\n',
        'App/L.xcstrings': catalog({
          a: { localizations: { en: unit('translated', 'A'), de: unit('translated', 'Ah') } },
        }),
      },
      (dir) => {
        const result = run(dir, {
          configPath: join(dir, '.xcstrings-lint.yml'),
          configExplicit: true,
        })
        expect(result.report.shortfalls).toEqual([])
        expect(result.report.passed).toBe(true)
      },
    )
  })

  it('still reports a required language no catalog has', () => {
    project(
      {
        '.xcstrings-lint.yml': 'required: [de, xx]\n',
        'App/L.xcstrings': catalog({
          a: { localizations: { en: unit('translated', 'A'), de: unit('translated', 'Ah') } },
        }),
      },
      (dir) => {
        const result = run(dir, {
          configPath: join(dir, '.xcstrings-lint.yml'),
          configExplicit: true,
        })
        expect(result.report.shortfalls.map((s) => s.language)).toEqual(['xx'])
      },
    )
  })
})

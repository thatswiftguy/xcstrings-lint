import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  createIgnoreMatchers,
  createPathMatcher,
  defaultConfig,
  loadConfig,
  parseConfig,
} from '../src/core/config.js'

describe('defaults', () => {
  const config = defaultConfig()

  it('matches every catalog format out of the box', () => {
    expect(config.paths).toEqual(['**/*.xcstrings', '**/*.strings', '**/*.stringsdict'])
  })

  it('fails on missing, empty, new, duplicate keys and format specifiers', () => {
    expect(config.severity).toEqual({
      missing: 'error',
      empty: 'error',
      new: 'error',
      needsReview: 'warn',
      stale: 'warn',
      formatSpecifier: 'error',
      pluralCoverage: 'warn',
      duplicateKey: 'error',
      duplicateValue: 'warn',
      orphanKey: 'warn',
      // Off by default: proper nouns are legitimately identical everywhere.
      identicalToSource: 'off',
    })
  })

  it('gates on every language it finds and overrides no source language', () => {
    expect(config.required).toBeUndefined()
    expect(config.sourceLanguage).toBeUndefined()
  })

  it('always skips vendored and derived directories', () => {
    const matches = createPathMatcher(config)
    expect(matches('App/Localizable.xcstrings')).toBe(true)
    expect(matches('Pods/Lib/Localizable.xcstrings')).toBe(false)
    expect(matches('node_modules/x/a.strings')).toBe(false)
    expect(matches('.build/checkouts/a/b.xcstrings')).toBe(false)
    expect(matches('DerivedData/x.xcstrings')).toBe(false)
    expect(matches('App/README.md')).toBe(false)
  })
})

describe('parsing', () => {
  it('treats an empty file as defaults', () => {
    expect(parseConfig('').severity).toEqual(defaultConfig().severity)
    expect(parseConfig('# just a comment\n').paths).toEqual(defaultConfig().paths)
  })

  it('reads a full config', () => {
    const config = parseConfig(`
paths:
  - 'Sources/**/*.xcstrings'
sourceLanguage: en
required: [de, fr, ja]
failOn: [missing, empty]
warnOn: [needsReview, stale]
ignore:
  keys: ['app_name', 'OK']
  patterns: ['debug_*']
  files: ['**/Tests/**']
formatSpecifiers: error
pluralCoverage: warn
`)
    expect(config.paths).toEqual(['Sources/**/*.xcstrings'])
    expect(config.sourceLanguage).toBe('en')
    expect(config.required).toEqual(['de', 'fr', 'ja'])
    expect(config.ignoreKeys).toEqual(['app_name', 'OK'])
    expect(config.ignoreFiles).toContain('**/Tests/**')
  })

  it('lets an explicit failOn replace the default rather than extend it', () => {
    const config = parseConfig('failOn: [missing]')
    expect(config.severity.missing).toBe('error')
    expect(config.severity.empty).toBe('off')
    expect(config.severity.new).toBe('off')
    // warnOn was not touched, so its default still applies.
    expect(config.severity.needsReview).toBe('warn')
  })

  it('lets every class be turned off entirely', () => {
    const config = parseConfig(
      [
        'failOn: []',
        'warnOn: []',
        'pluralCoverage: off',
        'formatSpecifiers: off',
        'duplicateKeys: off',
        'duplicateValues: off',
        'orphanKeys: off',
        'identicalToSource: off',
      ].join('\n'),
    )
    expect(Object.values(config.severity).every((s) => s === 'off')).toBe(true)
  })

  it('reads a severity for each of the newer checks', () => {
    const config = parseConfig(
      ['duplicateKeys: warn', 'duplicateValues: error', 'orphanKeys: off', 'identicalToSource: error'].join(
        '\n',
      ),
    )
    expect(config.severity.duplicateKey).toBe('warn')
    expect(config.severity.duplicateValue).toBe('error')
    expect(config.severity.orphanKey).toBe('off')
    expect(config.severity.identicalToSource).toBe('error')
  })
})

describe('invalid configuration', () => {
  const message = (text: string): string => {
    try {
      parseConfig(text)
      throw new Error('expected a ConfigError')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      return (error as ConfigError).message
    }
  }

  it('rejects an unknown severity with the allowed values', () => {
    expect(message('pluralCoverage: loud')).toContain(
      "pluralCoverage: Invalid enum value. Expected 'error' | 'warn' | 'off', received 'loud'",
    )
  })

  it('rejects a misspelled top-level key', () => {
    expect(message('sourcelanguage: en')).toContain("Unrecognized key(s) in object: 'sourcelanguage'")
  })

  it('rejects a misspelled nested key', () => {
    expect(message('ignore:\n  keyz: [a]')).toContain("ignore: Unrecognized key(s) in object: 'keyz'")
  })

  it('points structural checks at their own option', () => {
    expect(message('failOn: [formatSpecifiers]')).toContain(
      '"formatSpecifiers" is configured with the top-level "formatSpecifiers:" option, not in failOn',
    )
  })

  it('rejects a class listed as both failing and warning', () => {
    expect(message('failOn: [missing]\nwarnOn: [missing]')).toContain(
      '"missing" listed in both failOn and warnOn',
    )
  })

  it('rejects an empty paths list', () => {
    expect(message('paths: []')).toContain('must list at least one glob')
  })

  it('reports a YAML syntax error with a line, once', () => {
    const text = message('required: [de\n')
    expect(text).toContain('invalid YAML (line 2)')
    expect(text).not.toMatch(/at line \d+, column \d+/)
  })

  it('rejects a top-level list', () => {
    expect(message('- a\n- b')).toContain('expected the file to contain a mapping of options')
  })

  it('never leaks a stack trace', () => {
    for (const bad of ['pluralCoverage: loud', 'paths: 3', '- a']) {
      expect(message(bad)).not.toContain('    at ')
    }
  })
})

describe('loading from disk', () => {
  it('falls back to defaults when the default path is absent', () => {
    const config = loadConfig('does-not-exist.yml')
    expect(config.source).toBeUndefined()
    expect(config.paths).toEqual(defaultConfig().paths)
  })

  it('fails when a user-named path is absent', () => {
    expect(() => loadConfig('nope.yml', true)).toThrowError(/config file not found: nope\.yml/)
  })
})

describe('ignore matching', () => {
  const config = parseConfig(`
ignore:
  keys: ['app_name', 'OK']
  patterns: ['debug_*', 'internal.**']
  files: ['**/Tests/**']
`)
  const { ignoresKey, ignoresFile } = createIgnoreMatchers(config)

  it('matches exact keys', () => {
    expect(ignoresKey('app_name')).toBe(true)
    expect(ignoresKey('OK')).toBe(true)
    expect(ignoresKey('ok')).toBe(false)
  })

  it('matches glob patterns', () => {
    expect(ignoresKey('debug_panel_title')).toBe(true)
    expect(ignoresKey('internal.tools.reset')).toBe(true)
    expect(ignoresKey('payment_title')).toBe(false)
  })

  it('matches file globs', () => {
    expect(ignoresFile('App/Tests/Localizable.xcstrings')).toBe(true)
    expect(ignoresFile('App/Sources/Localizable.xcstrings')).toBe(false)
  })
})

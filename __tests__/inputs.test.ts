import { describe, expect, it } from 'vitest'
import { readInputs, removedModeNotice } from '../src/action/inputs.js'
import { ConfigError } from '../src/core/config.js'

const reader =
  (values: Record<string, string> = {}) =>
  (name: string): string =>
    values[name] ?? ''

describe('action inputs', () => {
  it('falls back to the documented defaults when nothing is set', () => {
    expect(readInputs(reader())).toEqual({
      configPath: '.xcstrings-lint.yml',
      configExplicit: false,
      threshold: 100,
      comment: true,
      annotations: true,
      fail: true,
    })
  })

  it('treats a named config path as explicit, so "not found" is fatal', () => {
    expect(readInputs(reader({ config: 'ci/lint.yml' }))).toMatchObject({
      configPath: 'ci/lint.yml',
      configExplicit: true,
    })
  })

  it('does not treat the default path as explicit', () => {
    expect(readInputs(reader({ config: '.xcstrings-lint.yml' })).configExplicit).toBe(false)
  })

  it('accepts the casings a workflow actually produces', () => {
    for (const raw of ['true', 'True', 'TRUE']) {
      expect(readInputs(reader({ comment: raw })).comment).toBe(true)
    }
    for (const raw of ['false', 'False', 'FALSE']) {
      expect(readInputs(reader({ comment: raw })).comment).toBe(false)
    }
  })

  it('rejects a boolean it cannot read, rather than guessing', () => {
    expect(() => readInputs(reader({ fail: 'yes' }))).toThrowError(ConfigError)
    expect(() => readInputs(reader({ fail: 'yes' }))).toThrowError(/fail must be true or false/)
  })

  it('accepts a threshold in range and rejects one outside it', () => {
    expect(readInputs(reader({ threshold: '80' })).threshold).toBe(80)
    expect(readInputs(reader({ threshold: '0' })).threshold).toBe(0)
    for (const raw of ['-1', '101', 'lots', 'NaN']) {
      expect(() => readInputs(reader({ threshold: raw }))).toThrowError(ConfigError)
    }
  })

  it('surfaces a v1 mode input instead of ignoring it silently', () => {
    const inputs = readInputs(reader({ mode: 'ratchet' }))
    expect(inputs.removedMode).toBe('ratchet')
    const notice = removedModeNotice(inputs.removedMode!)
    expect(notice).toContain('removed in v2')
    expect(notice).toContain('whole repository')
  })

  it('says nothing about mode when the workflow does not set it', () => {
    expect(readInputs(reader()).removedMode).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { detectBaseRef, readInputs } from '../src/action/inputs.js'
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
      mode: 'full',
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

  it('reads both modes, and defaults to the full scan', () => {
    expect(readInputs(reader()).mode).toBe('full')
    expect(readInputs(reader({ mode: 'full' })).mode).toBe('full')
    expect(readInputs(reader({ mode: 'ratchet' })).mode).toBe('ratchet')
  })

  it('still accepts the old name for the full scan', () => {
    expect(readInputs(reader({ mode: 'absolute' })).mode).toBe('full')
  })

  it('rejects a mode it does not know', () => {
    expect(() => readInputs(reader({ mode: 'strict' }))).toThrowError(
      /mode must be "full" or "ratchet"/,
    )
  })
})

describe('finding a base to compare against', () => {
  it('prefers the pull request base branch', () => {
    expect(
      detectBaseRef({ pullRequestBase: 'develop', environment: 'main', pushBefore: 'abc123' }),
    ).toBe('develop')
  })

  it('falls back to the environment, then to the previous push', () => {
    expect(detectBaseRef({ environment: 'main', pushBefore: 'abc123' })).toBe('main')
    expect(detectBaseRef({ pushBefore: 'abc123' })).toBe('abc123')
  })

  it('ignores the all-zero sha a brand new branch pushes', () => {
    expect(detectBaseRef({ pushBefore: '0000000000000000000000000000000000000000' })).toBeUndefined()
  })

  it('returns nothing when the event offers nothing', () => {
    expect(detectBaseRef({})).toBeUndefined()
  })
})

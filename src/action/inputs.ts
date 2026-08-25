import { ConfigError, DEFAULT_CONFIG_PATH } from '../core/config.js'
import type { Mode } from '../lint.js'

export interface ActionInputs {
  configPath: string
  /** True when the user named the config path, so "not found" is fatal. */
  configExplicit: boolean
  mode: Mode
  threshold: number
  comment: boolean
  annotations: boolean
  fail: boolean
}

/** Reads one action input. Injected so this file never imports @actions/core. */
export type InputReader = (name: string) => string

/**
 * Read and validate every input up front.
 *
 * All of it is pure, so the validation rules can be tested without a runner,
 * and every failure lands on the same "you configured this wrong" path (exit 2)
 * rather than surfacing as a stack trace halfway through a run.
 */
export function readInputs(get: InputReader): ActionInputs {
  const configPath = (get('config') || '').trim() || DEFAULT_CONFIG_PATH

  return {
    configPath,
    // The default path is allowed to be absent -- zero-config is supported.
    configExplicit: configPath !== DEFAULT_CONFIG_PATH,
    mode: readMode(get),
    threshold: readThreshold(get),
    comment: readBoolean(get, 'comment', true),
    annotations: readBoolean(get, 'annotations', true),
    fail: readBoolean(get, 'fail', true),
  }
}

function readMode(get: InputReader): Mode {
  const value = (get('mode') || '').trim()
  if (value === '') return 'full'
  if (value === 'full' || value === 'ratchet') return value
  // `absolute` was the old name for what `full` does now. Accepting it costs a
  // line and saves anyone with it in their workflow a broken run.
  if (value === 'absolute') return 'full'
  throw new ConfigError(`mode must be "full" or "ratchet", got "${value}"`)
}

/**
 * Read a boolean input, falling back rather than throwing when it is absent.
 *
 * `core.getBooleanInput` throws on an empty value. Action defaults mean that
 * normally cannot happen, but a hard crash on a missing input is a poor trade
 * for a check whose whole job is to produce a readable failure.
 */
function readBoolean(get: InputReader, name: string, fallback: boolean): boolean {
  const raw = (get(name) || '').trim()
  if (raw === '') return fallback
  if (['true', 'True', 'TRUE'].includes(raw)) return true
  if (['false', 'False', 'FALSE'].includes(raw)) return false
  throw new ConfigError(`${name} must be true or false, got "${raw}"`)
}

function readThreshold(get: InputReader): number {
  const raw = (get('threshold') || '').trim() || '100'
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new ConfigError(`threshold must be a number between 0 and 100, got "${raw}"`)
  }
  return value
}

export interface BaseRefSource {
  /** `payload.pull_request.base.ref`, when the event has one. */
  pullRequestBase?: string | undefined
  /** `$GITHUB_BASE_REF`. */
  environment?: string | undefined
  /** `payload.before` on a push. */
  pushBefore?: string | undefined
}

/**
 * Work out what to compare against.
 *
 * Pull requests give a base branch. Pushes do not, but `payload.before` is the
 * commit the branch was at, which is the right comparison for a push -- so
 * `on: push` gets the new-versus-pre-existing split too, without anyone having
 * to configure it. Undefined simply means no split; only ratchet mode treats
 * that as fatal.
 */
export function detectBaseRef(source: BaseRefSource): string | undefined {
  if (source.pullRequestBase) return source.pullRequestBase
  if (source.environment) return source.environment
  // All-zeros means the branch did not exist before this push.
  const before = source.pushBefore
  if (before && !/^0+$/.test(before)) return before
  return undefined
}

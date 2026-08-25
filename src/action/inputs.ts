import { ConfigError, DEFAULT_CONFIG_PATH } from '../core/config.js'

export interface ActionInputs {
  configPath: string
  /** True when the user named the config path, so "not found" is fatal. */
  configExplicit: boolean
  threshold: number
  comment: boolean
  annotations: boolean
  fail: boolean
  /**
   * Set when the workflow still passes the v1 `mode` input. The check has no
   * modes any more; this exists only so we can say so out loud instead of
   * silently ignoring it.
   */
  removedMode?: string
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
  const mode = (get('mode') || '').trim()

  return {
    configPath,
    // The default path is allowed to be absent -- zero-config is supported.
    configExplicit: configPath !== DEFAULT_CONFIG_PATH,
    threshold: readThreshold(get),
    comment: readBoolean(get, 'comment', true),
    annotations: readBoolean(get, 'annotations', true),
    fail: readBoolean(get, 'fail', true),
    ...(mode === '' ? {} : { removedMode: mode }),
  }
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

/** Told to the user once when a v1 workflow still sets `mode`. */
export function removedModeNotice(mode: string): string {
  return (
    `The "mode" input was removed in v2 and "${mode}" is being ignored. ` +
    'Every run now checks the whole repository; there is no base-branch comparison. ' +
    'Delete the line from your workflow.'
  )
}

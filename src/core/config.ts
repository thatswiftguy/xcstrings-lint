import { readFileSync } from 'node:fs'
import { parse as parseYaml, YAMLParseError } from 'yaml'
import picomatch from 'picomatch'
import { z } from 'zod'
import {
  ALL_ISSUE_CLASSES,
  STATE_ISSUE_CLASSES,
  type IssueClass,
  type Severity,
  type StateIssueClass,
} from './types.js'

/** Anything the user got wrong. Always exit code 2, never a stack trace. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export const DEFAULT_CONFIG_PATH = '.xcstrings-lint.yml'

const DEFAULT_PATHS = ['**/*.xcstrings', '**/*.strings', '**/*.stringsdict']

/**
 * Applied on top of whatever the user lists. These directories hold vendored or
 * derived copies of catalogs; reporting them is always noise.
 */
const ALWAYS_IGNORED_FILES = [
  '**/node_modules/**',
  '**/Pods/**',
  '**/Carthage/**',
  '**/.build/**',
  '**/DerivedData/**',
  '**/.git/**',
]

const DEFAULT_FAIL_ON: StateIssueClass[] = ['missing', 'empty', 'new']
const DEFAULT_WARN_ON: StateIssueClass[] = ['needsReview', 'stale']

/**
 * Severity of each non-state check when the user says nothing.
 *
 * `duplicateKeys` fails: a key declared twice means one of the two definitions
 * is silently discarded by Xcode, so whatever it said is already lost.
 * `identicalToSource` is off, because "Cancel" is a legitimate translation into
 * a dozen languages and a check that cries wolf gets the whole tool switched
 * off. It is one line to enable when a project wants it.
 */
const DEFAULT_CHECK_SEVERITY = {
  formatSpecifier: 'error',
  pluralCoverage: 'warn',
  duplicateKey: 'error',
  duplicateValue: 'warn',
  orphanKey: 'warn',
  identicalToSource: 'off',
} as const satisfies Partial<Record<IssueClass, Severity>>

const severitySchema = z.enum(['error', 'warn', 'off'])
const stateClassSchema = z.enum(['missing', 'empty', 'new', 'needsReview', 'stale'])

const nonEmptyString = z.string().min(1, 'must not be empty')

const fileSchema = z
  .object({
    paths: z.array(nonEmptyString).min(1, 'must list at least one glob').optional(),
    sourceLanguage: nonEmptyString.optional(),
    required: z.array(nonEmptyString).optional(),
    failOn: z.array(stateClassSchema).optional(),
    warnOn: z.array(stateClassSchema).optional(),
    ignore: z
      .object({
        keys: z.array(z.string()).optional(),
        patterns: z.array(nonEmptyString).optional(),
        files: z.array(nonEmptyString).optional(),
      })
      .strict()
      .optional(),
    formatSpecifiers: severitySchema.optional(),
    pluralCoverage: severitySchema.optional(),
    duplicateKeys: severitySchema.optional(),
    duplicateValues: severitySchema.optional(),
    orphanKeys: severitySchema.optional(),
    identicalToSource: severitySchema.optional(),
  })
  .strict()

export type ConfigFile = z.infer<typeof fileSchema>

export interface ResolvedConfig {
  paths: string[]
  /** Overrides each catalog's own `sourceLanguage` when set. */
  sourceLanguage?: string
  /** Languages to gate on. Undefined means "every language found". */
  required?: string[]
  severity: Record<IssueClass, Severity>
  ignoreKeys: string[]
  ignoreKeyPatterns: string[]
  ignoreFiles: string[]
  /** Where this came from, for error messages. Undefined when defaulted. */
  source?: string
}

export function defaultConfig(): ResolvedConfig {
  return resolve({})
}

/**
 * Load and validate a config file.
 *
 * A missing file is not an error -- zero-config is a supported way to run. Only
 * an unreadable or invalid file is.
 *
 * @param path     path to the YAML file
 * @param explicit true when the user named this path, so "not found" is fatal
 */
export function loadConfig(path: string, explicit = false): ResolvedConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' && !explicit) return defaultConfig()
    if (code === 'ENOENT') throw new ConfigError(`config file not found: ${path}`)
    throw new ConfigError(`could not read config file ${path}: ${(error as Error).message}`)
  }
  return parseConfig(text, path)
}

export function parseConfig(text: string, path = DEFAULT_CONFIG_PATH): ResolvedConfig {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const line = error.linePos?.[0]?.line
      const where = line === undefined ? '' : ` (line ${line})`
      // yaml repeats "at line N, column M" in the message; we already say it.
      const detail = (error.message.split('\n')[0] ?? error.message).replace(
        / at line \d+, column \d+:?$/,
        '',
      )
      throw new ConfigError(`${path}: invalid YAML${where}: ${detail}`)
    }
    throw new ConfigError(`${path}: invalid YAML: ${(error as Error).message}`)
  }

  // An empty file parses to null. That is a legitimate "use the defaults".
  if (raw === null || raw === undefined) return { ...resolve({}), source: path }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(
      `${path}: expected the file to contain a mapping of options, found ${
        Array.isArray(raw) ? 'a list' : typeof raw
      }`,
    )
  }

  const result = fileSchema.safeParse(raw)
  if (!result.success) throw new ConfigError(formatIssues(path, result.error))

  const config = result.data
  const overlap = (config.failOn ?? []).filter((c) => (config.warnOn ?? []).includes(c))
  if (overlap.length > 0) {
    throw new ConfigError(
      `${path}: ${overlap.map((c) => `"${c}"`).join(', ')} listed in both failOn and warnOn -- pick one`,
    )
  }

  return { ...resolve(config), source: path }
}

/** Options that are configured at the top level, not inside failOn/warnOn. */
const TOP_LEVEL_CHECKS = [
  'formatSpecifiers',
  'pluralCoverage',
  'duplicateKeys',
  'duplicateValues',
  'orphanKeys',
  'identicalToSource',
]

function formatIssues(path: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    let message = issue.message

    // Point people at the right knob instead of just rejecting the value.
    if (
      (where.startsWith('failOn') || where.startsWith('warnOn')) &&
      issue.code === 'invalid_enum_value'
    ) {
      const received = String((issue as { received?: unknown }).received ?? '')
      if (TOP_LEVEL_CHECKS.includes(received)) {
        message = `"${received}" is configured with the top-level "${received}:" option, not in ${where.split('.')[0]}`
      }
    }
    return `  - ${where}: ${message}`
  })
  return `${path}: invalid configuration\n${lines.join('\n')}`
}

function resolve(config: ConfigFile): ResolvedConfig {
  // An explicit list replaces the default outright, so `failOn: [missing]`
  // genuinely means "only missing fails" rather than "missing plus the usual".
  const failOn = config.failOn ?? DEFAULT_FAIL_ON
  const warnOn = config.warnOn ?? DEFAULT_WARN_ON

  const severity = Object.fromEntries(
    ALL_ISSUE_CLASSES.map((issueClass) => [issueClass, 'off' as Severity]),
  ) as Record<IssueClass, Severity>

  for (const issueClass of STATE_ISSUE_CLASSES) {
    if (failOn.includes(issueClass)) severity[issueClass] = 'error'
    else if (warnOn.includes(issueClass)) severity[issueClass] = 'warn'
  }

  severity.formatSpecifier = config.formatSpecifiers ?? DEFAULT_CHECK_SEVERITY.formatSpecifier
  severity.pluralCoverage = config.pluralCoverage ?? DEFAULT_CHECK_SEVERITY.pluralCoverage
  severity.duplicateKey = config.duplicateKeys ?? DEFAULT_CHECK_SEVERITY.duplicateKey
  severity.duplicateValue = config.duplicateValues ?? DEFAULT_CHECK_SEVERITY.duplicateValue
  severity.orphanKey = config.orphanKeys ?? DEFAULT_CHECK_SEVERITY.orphanKey
  severity.identicalToSource = config.identicalToSource ?? DEFAULT_CHECK_SEVERITY.identicalToSource

  return {
    paths: config.paths ?? DEFAULT_PATHS,
    ...(config.sourceLanguage === undefined ? {} : { sourceLanguage: config.sourceLanguage }),
    ...(config.required === undefined ? {} : { required: config.required }),
    severity,
    ignoreKeys: config.ignore?.keys ?? [],
    ignoreKeyPatterns: config.ignore?.patterns ?? [],
    ignoreFiles: [...ALWAYS_IGNORED_FILES, ...(config.ignore?.files ?? [])],
  }
}

export interface IgnoreMatchers {
  ignoresKey: (key: string) => boolean
  ignoresFile: (path: string) => boolean
}

/**
 * Compile the ignore lists once.
 *
 * Key patterns are globs, not regexes -- `debug_*` is what a user writes and
 * expects to work, and using one syntax for both key and file patterns means
 * there is only one thing to learn.
 */
export function createIgnoreMatchers(config: ResolvedConfig): IgnoreMatchers {
  const exactKeys = new Set(config.ignoreKeys)
  const keyMatcher =
    config.ignoreKeyPatterns.length > 0
      ? picomatch(config.ignoreKeyPatterns, { dot: true })
      : undefined
  const fileMatcher =
    config.ignoreFiles.length > 0 ? picomatch(config.ignoreFiles, { dot: true }) : undefined

  return {
    ignoresKey: (key) => exactKeys.has(key) || (keyMatcher?.(key) ?? false),
    ignoresFile: (path) => fileMatcher?.(path) ?? false,
  }
}

export function createPathMatcher(config: ResolvedConfig): (path: string) => boolean {
  const include = picomatch(config.paths, { dot: true })
  const { ignoresFile } = createIgnoreMatchers(config)
  return (path) => include(path) && !ignoresFile(path)
}

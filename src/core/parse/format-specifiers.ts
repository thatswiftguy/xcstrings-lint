/**
 * Format-specifier parsing and comparison.
 *
 * This is the highest-value check in the tool. A missing translation shows the
 * wrong language; a specifier mismatch between `"You have %lld items"` and
 * `"Sie haben %@ Artikel"` reads a 64-bit integer as an object pointer and
 * crashes at runtime.
 *
 * Grammar (C99 + Apple extensions + String Catalog extensions):
 *
 *     %[argnum$][flags][width][.precision][length]conversion
 *     %%                  literal percent
 *     %[argnum$]#@name@   String Catalog substitution reference
 *     %arg                the substituted argument, inside a substitution branch
 *
 * The two String Catalog forms have to be special-cased: `#` is a valid C flag
 * and `@` a valid conversion, so `%1$#@files@` would otherwise scan as "object
 * at position 1" when it actually stands in for whatever `formatSpecifier` the
 * substitution declares -- usually `lld`.
 */

export type TypeClass =
  | 'object'
  | 'string'
  | 'integer'
  | 'float'
  | 'char'
  | 'pointer'
  | 'count'
  | 'unknown'

/** Argument width implied by the length modifier. Only meaningful for integers. */
export type WidthClass = 'default' | 'char' | 'short' | 'long' | 'longlong' | 'size' | 'intmax'

export type SpecifierKind = 'conversion' | 'substitution' | 'argument'

export interface FormatSpecifier {
  kind: SpecifierKind
  /** Exact source text, e.g. `%1$lld`. Used verbatim in messages. */
  raw: string
  /** 1-based argument position: explicit from `n$`, otherwise sequential. */
  position: number
  explicitPosition: boolean
  offset: number
  conversion?: string
  length?: string
  typeClass?: TypeClass
  width?: WidthClass
  /** Set when `kind === 'substitution'`. */
  substitutionName?: string
  /** True when width or precision is `*`, which consumes an extra argument. */
  consumesExtraArgs?: boolean
}

const FLAGS = "-+ #0'"
const LENGTH_MODIFIERS = ['hh', 'll', 'h', 'l', 'L', 'q', 'j', 'z', 't', 'Z'] as const

const TYPE_CLASSES: Record<string, TypeClass> = {
  '@': 'object',
  s: 'string',
  S: 'string',
  d: 'integer',
  i: 'integer',
  o: 'integer',
  u: 'integer',
  x: 'integer',
  X: 'integer',
  D: 'integer',
  U: 'integer',
  O: 'integer',
  f: 'float',
  F: 'float',
  e: 'float',
  E: 'float',
  g: 'float',
  G: 'float',
  a: 'float',
  A: 'float',
  c: 'char',
  C: 'char',
  p: 'pointer',
  n: 'count',
}

const WIDTHS: Record<string, WidthClass> = {
  hh: 'char',
  h: 'short',
  l: 'long',
  ll: 'longlong',
  q: 'longlong',
  L: 'longlong',
  z: 'size',
  t: 'size',
  j: 'intmax',
  Z: 'size',
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'

export function parseFormatSpecifiers(value: string): FormatSpecifier[] {
  const out: FormatSpecifier[] = []
  let implicit = 0
  let i = 0

  while (i < value.length) {
    if (value[i] !== '%') {
      i++
      continue
    }

    const start = i
    i++
    if (i >= value.length) break

    // %% -- a literal percent, not an argument.
    if (value[i] === '%') {
      i++
      continue
    }

    // %arg -- String Catalog placeholder for the substituted argument itself.
    if (value.startsWith('arg', i) && !/[A-Za-z0-9]/.test(value[i + 3] ?? '')) {
      i += 3
      out.push({
        kind: 'argument',
        raw: value.slice(start, i),
        position: ++implicit,
        explicitPosition: false,
        offset: start,
      })
      continue
    }

    let position: number | undefined
    let digits = i
    while (isDigit(value[digits])) digits++
    if (digits > i && value[digits] === '$') {
      position = Number(value.slice(i, digits))
      i = digits + 1
    }

    // [argnum$]#@name@ -- substitution reference. Must precede flag scanning,
    // because '#' is itself a valid flag.
    if (value[i] === '#' && value[i + 1] === '@') {
      const close = value.indexOf('@', i + 2)
      if (close !== -1) {
        const name = value.slice(i + 2, close)
        i = close + 1
        out.push({
          kind: 'substitution',
          raw: value.slice(start, i),
          position: position ?? ++implicit,
          explicitPosition: position !== undefined,
          offset: start,
          substitutionName: name,
        })
        continue
      }
    }

    let consumesExtraArgs = false

    while (i < value.length && FLAGS.includes(value[i] as string)) i++

    if (value[i] === '*') {
      consumesExtraArgs = true
      i++
    } else {
      while (isDigit(value[i])) i++
    }

    if (value[i] === '.') {
      i++
      if (value[i] === '*') {
        consumesExtraArgs = true
        i++
      } else {
        while (isDigit(value[i])) i++
      }
    }

    let length: string | undefined
    for (const modifier of LENGTH_MODIFIERS) {
      if (value.startsWith(modifier, i)) {
        length = modifier
        i += modifier.length
        break
      }
    }

    const conversion = value[i]
    if (conversion === undefined) break
    i++

    out.push({
      kind: 'conversion',
      raw: value.slice(start, i),
      position: position ?? ++implicit,
      explicitPosition: position !== undefined,
      offset: start,
      conversion,
      ...(length === undefined ? {} : { length }),
      typeClass: TYPE_CLASSES[conversion] ?? 'unknown',
      width: length === undefined ? 'default' : (WIDTHS[length] ?? 'default'),
      ...(consumesExtraArgs ? { consumesExtraArgs } : {}),
    })
  }

  return out
}

export type MismatchKind = 'missing' | 'extra' | 'type' | 'width'

export interface FormatMismatch {
  kind: MismatchKind
  /**
   * `error` for anything that changes how the argument is read -- that is a
   * crash. `warn` for a width change within the same type class, which is a
   * real bug on 64-bit but usually prints garbage rather than trapping.
   */
  severity: 'error' | 'warn'
  position: number
  expected?: string
  found?: string
  message: string
}

export interface FormatComparisonOptions {
  /** Substitution tables, used to resolve `%#@name@` down to a real conversion. */
  sourceSubstitutions?: Record<string, { formatSpecifier?: string }> | undefined
  targetSubstitutions?: Record<string, { formatSpecifier?: string }> | undefined
}

interface Resolved {
  specifier: FormatSpecifier
  typeClass: TypeClass
  width: WidthClass
  display: string
}

/**
 * Resolve a substitution reference to the conversion it actually stands for, so
 * `%1$#@files@` declared as `lld` compares equal to a plain `%1$lld`.
 */
function resolve(
  specifier: FormatSpecifier,
  substitutions: Record<string, { formatSpecifier?: string }> | undefined,
): Resolved {
  if (specifier.kind === 'substitution') {
    const declared = substitutions?.[specifier.substitutionName ?? '']?.formatSpecifier
    if (declared) {
      const parsed = parseFormatSpecifiers(`%${declared}`)[0]
      if (parsed) {
        return {
          specifier,
          typeClass: parsed.typeClass ?? 'unknown',
          width: parsed.width ?? 'default',
          display: specifier.raw,
        }
      }
    }
    // Undeclared substitution: we know it is *an* argument but not its type.
    return { specifier, typeClass: 'unknown', width: 'default', display: specifier.raw }
  }

  if (specifier.kind === 'argument') {
    return { specifier, typeClass: 'unknown', width: 'default', display: specifier.raw }
  }

  return {
    specifier,
    typeClass: specifier.typeClass ?? 'unknown',
    width: specifier.width ?? 'default',
    display: specifier.raw,
  }
}

function byPosition(
  specifiers: FormatSpecifier[],
  substitutions: Record<string, { formatSpecifier?: string }> | undefined,
): Map<number, Resolved> {
  const map = new Map<number, Resolved>()
  for (const specifier of specifiers) {
    // Last one wins; a repeated position is legal (`%1$@ ... %1$@`).
    map.set(specifier.position, resolve(specifier, substitutions))
  }
  return map
}

/**
 * Compare the specifiers of a source string against a translation.
 *
 * Order may legitimately differ -- that is the entire point of positional
 * specifiers -- so this compares the index-to-type mapping, never the sequence.
 */
export function compareFormatSpecifiers(
  source: string,
  target: string,
  options: FormatComparisonOptions = {},
): FormatMismatch[] {
  const sourceMap = byPosition(parseFormatSpecifiers(source), options.sourceSubstitutions)
  const targetMap = byPosition(parseFormatSpecifiers(target), options.targetSubstitutions)

  const positions = [...new Set([...sourceMap.keys(), ...targetMap.keys()])].sort((a, b) => a - b)
  const mismatches: FormatMismatch[] = []

  for (const position of positions) {
    const expected = sourceMap.get(position)
    const found = targetMap.get(position)

    if (expected && !found) {
      mismatches.push({
        kind: 'missing',
        severity: 'error',
        position,
        expected: expected.display,
        message: `expected ${expected.display} at position ${position}, found nothing`,
      })
      continue
    }

    if (!expected && found) {
      mismatches.push({
        kind: 'extra',
        severity: 'error',
        position,
        found: found.display,
        message: `found ${found.display} at position ${position}, which the source does not have`,
      })
      continue
    }

    if (!expected || !found) continue

    // An unknown type on either side means we could not resolve it; do not
    // invent a mismatch we cannot stand behind.
    const comparable = expected.typeClass !== 'unknown' && found.typeClass !== 'unknown'

    if (comparable && expected.typeClass !== found.typeClass) {
      mismatches.push({
        kind: 'type',
        severity: 'error',
        position,
        expected: expected.display,
        found: found.display,
        message: `expected ${expected.display} at position ${position}, found ${found.display}`,
      })
      continue
    }

    if (comparable && expected.width !== found.width) {
      mismatches.push({
        kind: 'width',
        severity: 'warn',
        position,
        expected: expected.display,
        found: found.display,
        message: `expected ${expected.display} at position ${position}, found ${found.display} (same type, different width)`,
      })
    }
  }

  return mismatches
}

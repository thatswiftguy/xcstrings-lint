import { basename, dirname, posix } from 'node:path'
import { LineIndex, stripBom } from './line-index.js'
import {
  CatalogParseError,
  type Catalog,
  type CatalogEntry,
  type Localization,
  type SourceLocation,
  type ValueNode,
} from './types.js'
import { type PluralCategory } from './cldr-plurals.js'

const PLURAL_CATEGORIES = new Set<string>(['zero', 'one', 'two', 'few', 'many', 'other'])

/**
 * Decode a legacy strings file.
 *
 * Xcode wrote `.strings` as UTF-16 for years and plenty of files still are, so
 * reading everything as UTF-8 would turn half a repo into mojibake. BOMs cover
 * most of them; the heuristic covers BOM-less UTF-16, which also exists.
 */
export function decodeTextFile(buffer: Buffer): string {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return buffer.subarray(2).toString('utf16le')
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le')
    }
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }

  // BOM-less UTF-16: ASCII text leaves a NUL in every other byte. Which half
  // holds the NULs tells us the endianness.
  const sample = buffer.subarray(0, Math.min(buffer.length, 256))
  let evenNulls = 0
  let oddNulls = 0
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0x00) (i % 2 === 0 ? evenNulls++ : oddNulls++)
  }
  const nulls = evenNulls + oddNulls
  if (sample.length >= 4 && nulls > sample.length / 4) {
    const even = buffer.length % 2 === 0 ? buffer : buffer.subarray(0, buffer.length - 1)
    return oddNulls >= evenNulls
      ? even.toString('utf16le')
      : Buffer.from(even).swap16().toString('utf16le')
  }

  return stripBom(buffer.toString('utf8'))
}

export interface StringsEntry {
  key: string
  value: string
  loc: SourceLocation
  comment?: string
}

/**
 * Parse a legacy `"key" = "value";` table.
 *
 * Handles both comment styles, escaped quotes, `\U0041` escapes and the
 * shorthand `"key";` form that means key-equals-value.
 */
export function parseStringsFile(filePath: string, buffer: Buffer): StringsEntry[] {
  const text = decodeTextFile(buffer)
  const index = new LineIndex(text)
  const at = (offset: number): SourceLocation => {
    const { line, column } = index.locate(offset)
    return { file: filePath, line, column }
  }
  const fail = (offset: number, message: string): never => {
    const { line, column } = index.locate(offset)
    throw new CatalogParseError(filePath, `${message} at line ${line}, column ${column}`, line, column)
  }

  const entries: StringsEntry[] = []
  let i = 0
  let pendingComment: string | undefined

  const skipTrivia = (): void => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i] as string)) i++
      if (text[i] === '/' && text[i + 1] === '/') {
        const start = i + 2
        while (i < text.length && text[i] !== '\n') i++
        pendingComment = text.slice(start, i).trim() || pendingComment
        continue
      }
      if (text[i] === '/' && text[i + 1] === '*') {
        const start = i + 2
        const end = text.indexOf('*/', start)
        if (end === -1) fail(i, 'unterminated block comment')
        pendingComment = text.slice(start, end).trim() || pendingComment
        i = end + 2
        continue
      }
      return
    }
  }

  const readQuoted = (): string => {
    i++ // opening quote
    let out = ''
    while (i < text.length) {
      const ch = text[i] as string
      if (ch === '"') {
        i++
        return out
      }
      if (ch === '\\') {
        i++
        out += readEscape(text, () => i, (next) => (i = next), fail)
        continue
      }
      out += ch
      i++
    }
    return fail(i, 'unterminated string')
  }

  // Old-style plists allow bare identifiers as keys.
  const readBare = (): string => {
    const start = i
    while (i < text.length && /[A-Za-z0-9_.@$-]/.test(text[i] as string)) i++
    if (i === start) fail(i, `unexpected character ${JSON.stringify(text[i] ?? '<eof>')}`)
    return text.slice(start, i)
  }

  for (;;) {
    skipTrivia()
    if (i >= text.length) break

    const keyOffset = i
    const key = text[i] === '"' ? readQuoted() : readBare()

    skipTrivia()
    let value: string
    if (text[i] === '=') {
      i++
      skipTrivia()
      value = text[i] === '"' ? readQuoted() : readBare()
      skipTrivia()
    } else {
      // `"key";` -- the value is the key.
      value = key
    }

    if (text[i] === ';') i++
    else if (i < text.length) fail(i, `expected ";" after the value for "${key}"`)

    entries.push({
      key,
      value,
      loc: at(keyOffset),
      ...(pendingComment === undefined ? {} : { comment: pendingComment }),
    })
    pendingComment = undefined
  }

  return entries
}

function readEscape(
  text: string,
  get: () => number,
  set: (next: number) => void,
  fail: (offset: number, message: string) => never,
): string {
  let i = get()
  const ch = text[i]
  if (ch === undefined) fail(i, 'unterminated escape sequence')

  const simple: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '\r',
    '"': '"',
    "'": "'",
    '\\': '\\',
    '0': '\0',
  }
  if (ch in simple) {
    set(i + 1)
    return simple[ch] as string
  }
  if (ch === 'U' || ch === 'u') {
    const hex = text.slice(i + 1, i + 5)
    if (/^[0-9a-fA-F]{4}$/.test(hex)) {
      set(i + 5)
      return String.fromCharCode(parseInt(hex, 16))
    }
  }
  set(i + 1)
  return ch
}

type PlistValue =
  | { type: 'dict'; entries: Array<{ key: string; loc: SourceLocation; value: PlistValue }>; loc: SourceLocation }
  | { type: 'array'; items: PlistValue[]; loc: SourceLocation }
  | { type: 'string'; value: string; loc: SourceLocation }
  | { type: 'other'; loc: SourceLocation }

export interface StringsdictEntry {
  key: string
  localization: Localization
  loc: SourceLocation
}

/**
 * Parse the plural structure out of a `.stringsdict`.
 *
 * This is a targeted reader, not a general plist implementation: it understands
 * `dict`, `array` and `string`, which is everything a stringsdict uses, and it
 * exists so plural coverage works for projects that never migrated. The result
 * maps onto the same `Localization` shape as a String Catalog, so every
 * downstream check applies unchanged.
 */
export function parseStringsdictFile(filePath: string, buffer: Buffer): StringsdictEntry[] {
  const text = decodeTextFile(buffer)
  const index = new LineIndex(text)
  const at = (offset: number): SourceLocation => {
    const { line, column } = index.locate(offset)
    return { file: filePath, line, column }
  }
  const fail = (offset: number, message: string): never => {
    const { line, column } = index.locate(offset)
    throw new CatalogParseError(filePath, `${message} at line ${line}, column ${column}`, line, column)
  }

  const root = parsePlist(text, at, fail)
  if (!root || root.type !== 'dict') {
    throw new CatalogParseError(filePath, 'expected a <plist> containing a <dict>')
  }

  const out: StringsdictEntry[] = []
  for (const entry of root.entries) {
    if (entry.value.type !== 'dict') continue
    out.push({ key: entry.key, loc: entry.loc, localization: toLocalization(entry.value, entry.loc) })
  }
  return out
}

function toLocalization(dict: Extract<PlistValue, { type: 'dict' }>, loc: SourceLocation): Localization {
  const format = dict.entries.find((e) => e.key === 'NSStringLocalizedFormatKey')
  const localization: Localization = { loc }
  if (format?.value.type === 'string') {
    localization.unit = { state: 'translated', value: format.value.value }
  }

  const substitutions: Record<string, { formatSpecifier?: string } & ValueNode> = {}
  for (const entry of dict.entries) {
    if (entry.key === 'NSStringLocalizedFormatKey' || entry.value.type !== 'dict') continue

    const branches: Record<string, ValueNode> = {}
    for (const child of entry.value.entries) {
      if (!PLURAL_CATEGORIES.has(child.key) || child.value.type !== 'string') continue
      branches[child.key] = {
        unit: { state: 'translated', value: child.value.value },
        loc: child.loc,
      }
    }
    if (Object.keys(branches).length === 0) continue

    const valueType = entry.value.entries.find((e) => e.key === 'NSStringFormatValueTypeKey')
    substitutions[entry.key] = {
      loc: entry.loc,
      variations: [{ kind: 'plural', branches }],
      ...(valueType?.value.type === 'string' ? { formatSpecifier: valueType.value.value } : {}),
    }
  }

  if (Object.keys(substitutions).length > 0) localization.substitutions = substitutions
  return localization
}

function parsePlist(
  text: string,
  at: (offset: number) => SourceLocation,
  fail: (offset: number, message: string) => never,
): PlistValue | undefined {
  let i = 0

  const skipTrivia = (): void => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i] as string)) i++
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4)
        i = end === -1 ? text.length : end + 3
        continue
      }
      if (text.startsWith('<?', i)) {
        const end = text.indexOf('?>', i + 2)
        i = end === -1 ? text.length : end + 2
        continue
      }
      if (text.startsWith('<!', i)) {
        // DOCTYPE, possibly with an internal subset in brackets.
        const bracket = text.indexOf('[', i)
        const close = text.indexOf('>', i)
        if (bracket !== -1 && close !== -1 && bracket < close) {
          const endSubset = text.indexOf(']', bracket)
          const after = text.indexOf('>', endSubset === -1 ? bracket : endSubset)
          i = after === -1 ? text.length : after + 1
        } else {
          i = close === -1 ? text.length : close + 1
        }
        continue
      }
      return
    }
  }

  interface Tag {
    name: string
    selfClosing: boolean
    closing: boolean
    offset: number
  }

  const readTag = (): Tag | undefined => {
    skipTrivia()
    if (i >= text.length || text[i] !== '<') return undefined
    const offset = i
    const end = text.indexOf('>', i)
    if (end === -1) fail(i, 'unterminated tag')
    const inner = text.slice(i + 1, end).trim()
    i = end + 1
    const closing = inner.startsWith('/')
    const selfClosing = inner.endsWith('/')
    const name = inner.replace(/^\//, '').replace(/\/$/, '').trim().split(/\s/)[0] ?? ''
    return { name, selfClosing, closing, offset }
  }

  const readTextUntilClose = (name: string, offset: number): string => {
    const close = text.indexOf(`</${name}`, i)
    if (close === -1) fail(offset, `unterminated <${name}>`)
    const raw = text.slice(i, close)
    i = (text.indexOf('>', close) === -1 ? text.length : text.indexOf('>', close)) + 1
    return decodeXmlEntities(raw)
  }

  const parseValue = (tag: Tag): PlistValue => {
    const loc = at(tag.offset)
    if (tag.selfClosing) return { type: 'other', loc }

    switch (tag.name) {
      case 'dict': {
        const entries: Array<{ key: string; loc: SourceLocation; value: PlistValue }> = []
        for (;;) {
          const next = readTag()
          if (!next) fail(tag.offset, 'unterminated <dict>')
          if (next.closing && next.name === 'dict') break
          if (next.name !== 'key') fail(next.offset, `expected <key>, found <${next.name}>`)
          const key = readTextUntilClose('key', next.offset)
          const valueTag = readTag()
          if (!valueTag) fail(next.offset, `<key>${key}</key> has no value`)
          entries.push({ key, loc: at(next.offset), value: parseValue(valueTag) })
        }
        return { type: 'dict', entries, loc }
      }
      case 'array': {
        const items: PlistValue[] = []
        for (;;) {
          const next = readTag()
          if (!next) fail(tag.offset, 'unterminated <array>')
          if (next.closing && next.name === 'array') break
          items.push(parseValue(next))
        }
        return { type: 'array', items, loc }
      }
      case 'string':
        return { type: 'string', value: readTextUntilClose('string', tag.offset), loc }
      default:
        readTextUntilClose(tag.name, tag.offset)
        return { type: 'other', loc }
    }
  }

  let tag = readTag()
  while (tag && tag.name !== 'plist') tag = readTag()
  if (!tag) return undefined

  const inner = readTag()
  if (!inner) return undefined
  return parseValue(inner)
}

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default:
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
          return String.fromCodePoint(parseInt(entity.slice(2), 16))
        }
        if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10))
        return match
    }
  })
}

export interface LegacyFileInfo {
  /** Directory that holds the `.lproj` folders. */
  baseDir: string
  /** Language folder name with `.lproj` removed. */
  language: string
  /** Table name, e.g. `Localizable`. */
  table: string
  extension: 'strings' | 'stringsdict'
}

/** Pull the language and table out of `.../de.lproj/Localizable.strings`. */
export function legacyFileInfo(path: string): LegacyFileInfo | undefined {
  const normalized = path.split('\\').join('/')
  const folder = basename(dirname(normalized))
  if (!folder.endsWith('.lproj')) return undefined

  const file = basename(normalized)
  const extension = file.endsWith('.stringsdict') ? 'stringsdict' : file.endsWith('.strings') ? 'strings' : undefined
  if (!extension) return undefined

  return {
    baseDir: posix.dirname(posix.dirname(normalized)),
    language: folder.slice(0, -'.lproj'.length),
    table: file.slice(0, -(extension.length + 1)),
    extension,
  }
}

export interface LegacyFile {
  path: string
  buffer: Buffer
}

export interface AssembleOptions {
  /** Overrides the per-table source language detection. */
  sourceLanguage?: string | undefined
  /**
   * Called for each file that fails to parse. When supplied, that one file is
   * skipped and the rest of the tables still assemble, so a single broken file
   * reports as a single broken file rather than swallowing every other table.
   * When omitted, the error propagates.
   */
  onError?: ((error: CatalogParseError) => void) | undefined
}

/**
 * Group `.lproj` files into one catalog per table.
 *
 * `Localizable.strings` and `Localizable.stringsdict` are the same table -- the
 * stringsdict supplies plural forms for keys the strings file declares -- so
 * they merge rather than becoming two catalogs that each look half-empty.
 */
export function assembleLegacyCatalogs(
  files: LegacyFile[],
  options: AssembleOptions = {},
): Catalog[] {
  interface Table {
    baseDir: string
    table: string
    languages: Set<string>
    /** key -> language -> localization */
    keys: Map<string, Map<string, Localization>>
    /** key -> first location seen, for the entry anchor */
    anchors: Map<string, SourceLocation>
    order: string[]
  }

  const tables = new Map<string, Table>()

  for (const file of files) {
    const info = legacyFileInfo(file.path)
    if (!info) continue

    const id = `${info.baseDir}\u0000${info.table}`
    let table = tables.get(id)
    if (!table) {
      table = {
        baseDir: info.baseDir,
        table: info.table,
        languages: new Set(),
        keys: new Map(),
        anchors: new Map(),
        order: [],
      }
      tables.set(id, table)
    }
    table.languages.add(info.language)

    const record = (key: string, localization: Localization, loc: SourceLocation): void => {
      let byLanguage = table.keys.get(key)
      if (!byLanguage) {
        byLanguage = new Map()
        table.keys.set(key, byLanguage)
        table.order.push(key)
      }
      byLanguage.set(info.language, localization)
      if (!table.anchors.has(key)) table.anchors.set(key, loc)
    }

    try {
      if (info.extension === 'strings') {
        for (const entry of parseStringsFile(file.path, file.buffer)) {
          record(
            entry.key,
            { unit: { state: 'translated', value: entry.value }, loc: entry.loc },
            entry.loc,
          )
        }
      } else {
        for (const entry of parseStringsdictFile(file.path, file.buffer)) {
          // A stringsdict entry supersedes the flat string for the same key: it
          // is the richer, plural-aware definition of the same table entry.
          record(entry.key, entry.localization, entry.loc)
        }
      }
    } catch (error) {
      if (!options.onError || !(error instanceof CatalogParseError)) throw error
      options.onError(error)
    }
  }

  return [...tables.values()]
    .map((table): Catalog => {
      const languages = [...table.languages].sort()
      const sourceLanguage =
        options.sourceLanguage ??
        // Base.lproj is the development language by definition, so it is the
        // source rather than a target that looks perpetually untranslated.
        (languages.includes('Base') ? 'Base' : languages.includes('en') ? 'en' : (languages[0] ?? 'en'))

      const entries: CatalogEntry[] = table.order.map((key) => ({
        key,
        shouldTranslate: true,
        localizations: Object.fromEntries(table.keys.get(key) ?? []),
        loc: table.anchors.get(key) ?? { file: table.baseDir, line: 1 },
      }))

      return {
        // Synthetic: a legacy table spans one file per language, so the catalog
        // identity is the table, while every issue still points at a real file.
        path: posix.join(table.baseDir, `${table.table}.strings`),
        format: 'strings',
        sourceLanguage,
        entries,
        languages,
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

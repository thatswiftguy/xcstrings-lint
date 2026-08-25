import { parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser'
import { LineIndex, stripBom } from './line-index.js'
import {
  CatalogParseError,
  type Catalog,
  type CatalogEntry,
  type DuplicateKey,
  type Localization,
  type SourceLocation,
  type StringUnit,
  type Substitution,
  type ValueNode,
  type VariationKind,
  type VariationNode,
} from '../types.js'

const VARIATION_KINDS = new Set<string>(['plural', 'device'])

/**
 * Parse a `.xcstrings` String Catalog.
 *
 * This is plain JSON -- no Xcode, no `plutil`, no Apple toolchain. We use a
 * location-preserving parse rather than `JSON.parse` purely so that every key
 * and every per-language block carries a real line number for annotations.
 *
 * @param filePath repo-relative POSIX path, used verbatim in annotations
 * @param raw      the file's UTF-8 text
 */
export function parseXcstrings(filePath: string, raw: string): Catalog {
  const text = stripBom(raw)
  const index = new LineIndex(text)
  const at = (offset: number): SourceLocation => {
    const { line, column } = index.locate(offset)
    return { file: filePath, line, column }
  }

  const errors: ParseError[] = []
  const root = parseTree(text, errors, {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  })

  if (errors.length > 0) {
    const first = errors[0] as ParseError
    const { line, column } = index.locate(first.offset)
    throw new CatalogParseError(
      filePath,
      `invalid JSON: ${printParseErrorCode(first.error)} at line ${line}, column ${column}`,
      line,
      column,
    )
  }
  if (!root || root.type !== 'object') {
    throw new CatalogParseError(filePath, 'expected the file to contain a JSON object')
  }

  const sourceLanguage = stringProp(root, 'sourceLanguage') ?? 'en'
  const version = stringProp(root, 'version')

  const stringsNode = propValue(root, 'strings')
  if (stringsNode && stringsNode.type !== 'object') {
    throw new CatalogParseError(filePath, '"strings" must be a JSON object', at(stringsNode.offset).line)
  }

  // Insertion-ordered, and keyed so a redeclaration replaces rather than
  // appends. JSON is last-wins, so two `"app.title"` blocks are one entry as
  // far as Xcode is concerned -- appending both would double-count the key in
  // every coverage figure. The redeclaration is recorded instead.
  const byKey = new Map<string, CatalogEntry>()
  const duplicateKeys: DuplicateKey[] = []
  const languages = new Set<string>()

  for (const prop of objectProps(stringsNode)) {
    // An empty key is legal JSON but meaningless as a catalog entry, and Xcode
    // occasionally leaves one behind. Skip rather than crash.
    if (prop.key === '') continue

    if (!prop.value || prop.value.type !== 'object') {
      throw new CatalogParseError(
        filePath,
        `entry "${prop.key}" must be a JSON object, found ${prop.value?.type ?? 'nothing'}`,
        at(prop.keyNode.offset).line,
      )
    }

    const loc = at(prop.keyNode.offset)
    const previous = byKey.get(prop.key)
    if (previous) duplicateKeys.push({ key: prop.key, loc, firstLoc: previous.loc })

    byKey.set(prop.key, parseEntry(prop.key, prop.value, loc, at))
  }

  const entries = [...byKey.values()]
  for (const entry of entries) {
    for (const language of Object.keys(entry.localizations)) languages.add(language)
  }
  languages.add(sourceLanguage)

  return {
    path: filePath,
    format: 'xcstrings',
    sourceLanguage,
    ...(version === undefined ? {} : { version }),
    entries,
    languages: [...languages].sort(),
    duplicateKeys,
  }
}

function parseEntry(
  key: string,
  node: Node,
  keyLoc: SourceLocation,
  at: (offset: number) => SourceLocation,
): CatalogEntry {
  const localizationsNode = propValue(node, 'localizations')
  const localizations: Record<string, Localization> = {}

  for (const prop of objectProps(localizationsNode)) {
    if (prop.key === '' || !prop.value || prop.value.type !== 'object') continue
    localizations[prop.key] = parseLocalization(prop.value, at(prop.keyNode.offset), at)
  }

  const comment = stringProp(node, 'comment')
  const extractionState = stringProp(node, 'extractionState')

  return {
    key,
    ...(comment === undefined ? {} : { comment }),
    // Xcode omits the field when it is true; only an explicit false opts out.
    shouldTranslate: boolProp(node, 'shouldTranslate') ?? true,
    ...(extractionState === undefined ? {} : { extractionState }),
    localizations,
    loc: keyLoc,
  }
}

function parseLocalization(
  node: Node,
  loc: SourceLocation,
  at: (offset: number) => SourceLocation,
): Localization {
  const base = parseValueNode(node, loc, at)
  const substitutionsNode = propValue(node, 'substitutions')
  if (!substitutionsNode || substitutionsNode.type !== 'object') return base

  const substitutions: Record<string, Substitution> = {}
  for (const prop of objectProps(substitutionsNode)) {
    if (prop.key === '' || !prop.value || prop.value.type !== 'object') continue
    const subLoc = at(prop.keyNode.offset)
    const argNum = numberProp(prop.value, 'argNum')
    const formatSpecifier = stringProp(prop.value, 'formatSpecifier')
    substitutions[prop.key] = {
      ...parseValueNode(prop.value, subLoc, at),
      ...(argNum === undefined ? {} : { argNum }),
      ...(formatSpecifier === undefined ? {} : { formatSpecifier }),
    }
  }
  return Object.keys(substitutions).length > 0 ? { ...base, substitutions } : base
}

function parseValueNode(
  node: Node,
  loc: SourceLocation,
  at: (offset: number) => SourceLocation,
): ValueNode {
  const result: ValueNode = { loc }

  const unitNode = propValue(node, 'stringUnit')
  if (unitNode && unitNode.type === 'object') {
    result.unit = parseStringUnit(unitNode)
    result.loc = at(unitNode.offset)
  }

  const variationsNode = propValue(node, 'variations')
  const groups: VariationNode[] = []
  for (const prop of objectProps(variationsNode)) {
    if (!VARIATION_KINDS.has(prop.key) || !prop.value || prop.value.type !== 'object') continue
    const branches: Record<string, ValueNode> = {}
    for (const branchProp of objectProps(prop.value)) {
      if (branchProp.key === '' || !branchProp.value || branchProp.value.type !== 'object') continue
      branches[branchProp.key] = parseValueNode(
        branchProp.value,
        at(branchProp.keyNode.offset),
        at,
      )
    }
    if (Object.keys(branches).length > 0) {
      groups.push({ kind: prop.key as VariationKind, branches })
    }
  }
  if (groups.length > 0) result.variations = groups

  return result
}

function parseStringUnit(node: Node): StringUnit {
  return {
    // Xcode always writes a state; if one is missing, assume the translator
    // meant it. An empty `value` is caught by the `empty` check regardless.
    state: stringProp(node, 'state') ?? 'translated',
    value: stringProp(node, 'value') ?? '',
  }
}

interface ObjectProp {
  key: string
  keyNode: Node
  value: Node | undefined
}

function objectProps(node: Node | undefined): ObjectProp[] {
  if (!node || node.type !== 'object' || !node.children) return []
  const out: ObjectProp[] = []
  for (const child of node.children) {
    if (child.type !== 'property' || !child.children) continue
    const keyNode = child.children[0]
    if (!keyNode || typeof keyNode.value !== 'string') continue
    out.push({ key: keyNode.value, keyNode, value: child.children[1] })
  }
  return out
}

function propValue(node: Node | undefined, name: string): Node | undefined {
  // Last-wins on duplicate keys, matching JSON.parse.
  let found: Node | undefined
  for (const prop of objectProps(node)) {
    if (prop.key === name) found = prop.value
  }
  return found
}

function stringProp(node: Node | undefined, name: string): string | undefined {
  const value = propValue(node, name)
  return value && value.type === 'string' && typeof value.value === 'string'
    ? value.value
    : undefined
}

function boolProp(node: Node | undefined, name: string): boolean | undefined {
  const value = propValue(node, name)
  return value && value.type === 'boolean' && typeof value.value === 'boolean'
    ? value.value
    : undefined
}

function numberProp(node: Node | undefined, name: string): number | undefined {
  const value = propValue(node, name)
  return value && value.type === 'number' && typeof value.value === 'number'
    ? value.value
    : undefined
}

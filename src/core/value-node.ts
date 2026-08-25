import type {
  Leaf,
  SourceLocation,
  ValueNode,
  VariationKind,
  VariationNode,
  VariationStep,
} from './types.js'

/**
 * Flatten a value tree into its leaves.
 *
 * A localization is either one `stringUnit` (leaf path `[]`) or a tree of
 * variation branches, possibly nested (`device.iphone` -> `plural.one`). Every
 * downstream check -- completeness, plural coverage, format specifiers --
 * ultimately wants "the concrete strings in here, and how to name each one",
 * so they all go through this rather than re-walking the tree themselves.
 */
export function collectLeaves(node: ValueNode | undefined): Leaf[] {
  const out: Leaf[] = []
  if (!node) return out
  walk(node, [], out)
  return out
}

function walk(node: ValueNode, path: VariationStep[], out: Leaf[]): void {
  if (node.unit) out.push({ path, unit: node.unit, loc: node.loc })
  for (const group of node.variations ?? []) {
    for (const [branch, child] of Object.entries(group.branches)) {
      walk(child, [...path, { kind: group.kind, branch }], out)
    }
  }
}

/** Stable, human-readable name for a leaf: `""` at the root, else `plural.one`. */
export function leafPathLabel(path: VariationStep[]): string {
  return path.map((s) => `${s.kind}.${s.branch}`).join(' / ')
}

export function leafShape(node: ValueNode | undefined): Set<string> {
  return new Set(collectLeaves(node).map((l) => leafPathLabel(l.path)))
}

export interface FoundVariationGroup {
  path: VariationStep[]
  group: VariationNode
  /** Location of the node that owns the group, for annotating the group itself. */
  loc: SourceLocation
}

/** Every variation group of the given kind anywhere in the tree, with its path. */
export function findVariationGroups(
  node: ValueNode | undefined,
  kind: VariationKind,
): FoundVariationGroup[] {
  const out: FoundVariationGroup[] = []
  if (!node) return out
  const visit = (n: ValueNode, path: VariationStep[]): void => {
    for (const group of n.variations ?? []) {
      if (group.kind === kind) out.push({ path, group, loc: n.loc })
      for (const [branch, child] of Object.entries(group.branches)) {
        visit(child, [...path, { kind: group.kind, branch }])
      }
    }
  }
  visit(node, [])
  return out
}

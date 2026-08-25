/**
 * Maps byte offsets back to 1-based line/column.
 *
 * `JSON.parse` throws positions away, so the parsers keep the raw text around
 * and resolve offsets through this. Annotations that all point at line 1 are
 * useless, and this is what stops that happening.
 */
export class LineIndex {
  /** Offset at which each line starts. `starts[0]` is always 0. */
  private readonly starts: number[]

  constructor(text: string) {
    const starts = [0]
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1)
    }
    this.starts = starts
  }

  /** Resolve an offset. Offsets past the end clamp to the last line. */
  locate(offset: number): { line: number; column: number } {
    const starts = this.starts
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((starts[mid] as number) <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, column: Math.max(1, offset - (starts[lo] as number) + 1) }
  }

  get lineCount(): number {
    return this.starts.length
  }
}

/** Strip a UTF-8 BOM, which Node does not remove and JSON parsers choke on. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

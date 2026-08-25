import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { globSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const sourceFiles = globSync(['src/**/*.ts', '__tests__/**/*.ts'], { cwd: repoRoot }).map((file) =>
  typeof file === 'string' ? file : String(file),
)

/**
 * A raw control byte in a source file is invisible in an editor and works fine
 * at runtime, so nothing catches it -- except git, which then treats the file
 * as binary. That silently costs you the diff on every pull request and blocks
 * a textual merge. It has happened twice: both times a separator written as a
 * literal NUL instead of an escape.
 */
describe('source files stay textual', () => {
  it('finds source files to check', () => {
    expect(sourceFiles.length).toBeGreaterThan(15)
  })

  it.each(sourceFiles)('%s has no raw control bytes', (file) => {
    const text = readFileSync(join(repoRoot, file), 'utf8')
    const offenders: string[] = []
    for (let i = 0; i < text.length; i++) {
      const codePoint = text.charCodeAt(i)
      // Tab, newline and carriage return are the only ones that belong here.
      if (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) {
        const line = text.slice(0, i).split('\n').length
        offenders.push(`0x${codePoint.toString(16).padStart(2, '0')} at line ${line}`)
      }
    }
    expect(offenders, `${file} would be treated as binary by git`).toEqual([])
  })

  it('keeps every source file valid UTF-8 with no BOM', () => {
    // A strict decoder throws rather than substituting U+FFFD, so this cannot
    // be fooled the way a search for the replacement character can.
    const decoder = new TextDecoder('utf-8', { fatal: true })
    for (const file of sourceFiles) {
      const raw = readFileSync(join(repoRoot, file))
      expect(raw.subarray(0, 3), `${relative('.', file)} starts with a BOM`).not.toEqual(
        Buffer.from([0xef, 0xbb, 0xbf]),
      )
      expect(() => decoder.decode(raw), `${relative('.', file)} is not valid UTF-8`).not.toThrow()
    }
  })
})

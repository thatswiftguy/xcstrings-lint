import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

export function fixturePath(...parts: string[]): string {
  return join(here, 'fixtures', ...parts)
}

export function loadFixture(...parts: string[]): string {
  return readFileSync(fixturePath(...parts), 'utf8')
}

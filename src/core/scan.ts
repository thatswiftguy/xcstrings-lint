import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fastGlob from 'fast-glob'
import type { ResolvedConfig } from './config.js'
import { parseXcstrings } from './parse/xcstrings.js'
import {
  assembleLegacyCatalogs,
  decodeTextFile,
  legacyFileInfo,
  type LegacyFile,
} from './parse/strings.js'
import { CatalogParseError, type Catalog } from './types.js'

export interface ScanResult {
  catalogs: Catalog[]
  /** Files we could not parse. Always fatal for the run; never silently skipped. */
  errors: CatalogParseError[]
  /** Paths that matched the globs, whether or not they parsed. */
  matched: string[]
}

/**
 * Find and parse every catalog in the working tree.
 *
 * The whole repository, every time. There is no base-branch comparison and no
 * incremental mode: a translation that is missing is missing whether or not
 * this particular change is what dropped it, and a check that only looks at the
 * diff will never tell you the thing you actually want to know.
 */
export function scan(cwd: string, config: ResolvedConfig): ScanResult {
  const matched = fastGlob
    .sync(config.paths, {
      cwd,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: config.ignoreFiles,
    })
    .sort()

  const catalogs: Catalog[] = []
  const errors: CatalogParseError[] = []
  const legacy: LegacyFile[] = []

  for (const path of matched) {
    let buffer: Buffer
    try {
      buffer = readFileSync(join(cwd, path))
    } catch (error) {
      errors.push(new CatalogParseError(path, `could not read: ${(error as Error).message}`))
      continue
    }

    try {
      if (path.endsWith('.xcstrings')) {
        catalogs.push(parseXcstrings(path, decodeTextFile(buffer)))
      } else if (legacyFileInfo(path)) {
        legacy.push({ path, buffer })
      }
      // A .strings file outside an .lproj directory has no language to attach
      // it to, so there is nothing meaningful to check. Skip it silently.
    } catch (error) {
      if (error instanceof CatalogParseError) errors.push(error)
      else throw error
    }
  }

  catalogs.push(
    ...assembleLegacyCatalogs(legacy, {
      sourceLanguage: config.sourceLanguage,
      onError: (error) => errors.push(error),
    }),
  )

  return {
    catalogs: catalogs.sort((a, b) => a.path.localeCompare(b.path)),
    errors,
    matched,
  }
}

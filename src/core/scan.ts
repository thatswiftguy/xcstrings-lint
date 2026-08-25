import type { ResolvedConfig } from './config.js'
import { createPathMatcher } from './config.js'
import { parseXcstrings } from './parse/xcstrings.js'
import {
  assembleLegacyCatalogs,
  decodeTextFile,
  legacyFileInfo,
  type LegacyFile,
} from './parse/strings.js'
import { workingTreeFiles, type RevisionFiles } from './revision.js'
import { CatalogParseError, type Catalog } from './types.js'

export interface ScanResult {
  catalogs: Catalog[]
  /** Files we could not parse. Always fatal for the run; never silently skipped. */
  errors: CatalogParseError[]
  /** Paths that matched the globs, whether or not they parsed. */
  matched: string[]
}

/**
 * Find and parse every catalog at one revision.
 *
 * The whole tree, every time. What the base branch is used for is telling a
 * developer which of these problems they introduced -- never for deciding which
 * files to look at, because a translation that is missing is missing whether or
 * not this change is what dropped it.
 */
export function scan(source: RevisionFiles, config: ResolvedConfig): ScanResult {
  const matches = createPathMatcher(config)
  const matched = source.list().filter(matches).sort()

  const catalogs: Catalog[] = []
  const errors: CatalogParseError[] = []
  const legacy: LegacyFile[] = []

  for (const path of matched) {
    const buffer = source.read(path)
    if (!buffer) continue

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

/** Scan the checkout on disk. */
export function scanWorkingTree(cwd: string, config: ResolvedConfig): ScanResult {
  return scan(workingTreeFiles(cwd, config), config)
}

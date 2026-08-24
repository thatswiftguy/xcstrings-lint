import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import fastGlob from 'fast-glob'
import { createPathMatcher, type ResolvedConfig } from './config.js'
import { parseXcstrings } from './parse-xcstrings.js'
import { assembleLegacyCatalogs, legacyFileInfo, type LegacyFile } from './parse-strings.js'
import { decodeTextFile } from './parse-strings.js'
import { CatalogParseError, type Catalog } from './types.js'

/**
 * A set of files at one revision.
 *
 * The ratchet has to read the base branch without touching the working tree,
 * so file access is behind this interface: one implementation shells out to
 * `git show`, the other reads from disk, and the loading logic is shared.
 */
export interface RevisionFiles {
  /** Repo-relative POSIX paths of every file at this revision. */
  list(): string[]
  /** File contents, or undefined when the file does not exist here. */
  read(path: string): Buffer | undefined
  /** Human-readable name for messages, e.g. `origin/main` or `the working tree`. */
  label: string
}

export function workingTreeFiles(cwd: string, config: ResolvedConfig): RevisionFiles {
  return {
    label: 'the working tree',
    list: () =>
      fastGlob.sync(config.paths, {
        cwd,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        ignore: config.ignoreFiles,
      }),
    read: (path) => {
      try {
        return readFileSync(`${cwd}/${path}`)
      } catch {
        return undefined
      }
    },
  }
}

export function gitRevisionFiles(revision: string, cwd: string): RevisionFiles {
  return {
    label: revision,
    list: () => {
      const out = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', revision], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      })
      return out.split('\0').filter((line) => line.length > 0)
    },
    read: (path) => {
      try {
        return execFileSync('git', ['show', `${revision}:${path}`], {
          cwd,
          maxBuffer: 128 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      } catch {
        // Absent at this revision -- a file the PR added.
        return undefined
      }
    },
  }
}

export interface LoadResult {
  catalogs: Catalog[]
  /** Files we could not parse. Always fatal for the run; never silently skipped. */
  errors: CatalogParseError[]
}

/** Parse every catalog a revision contains, honouring the configured globs. */
export function loadCatalogs(source: RevisionFiles, config: ResolvedConfig): LoadResult {
  const matches = createPathMatcher(config)
  const paths = source.list().filter(matches).sort()

  const catalogs: Catalog[] = []
  const errors: CatalogParseError[] = []
  const legacy: LegacyFile[] = []

  for (const path of paths) {
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

  return { catalogs: catalogs.sort((a, b) => a.path.localeCompare(b.path)), errors }
}

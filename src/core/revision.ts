import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fastGlob from 'fast-glob'
import type { ResolvedConfig } from './config.js'

/**
 * A set of files at one revision.
 *
 * Reading the base branch must not touch the working tree, so file access sits
 * behind this interface: one implementation shells out to `git show`, the other
 * reads from disk, and the scanner is shared.
 */
export interface RevisionFiles {
  /** Repo-relative POSIX paths of every file at this revision. */
  list: () => string[]
  /** File contents, or undefined when the file does not exist here. */
  read: (path: string) => Buffer | undefined
  /** Human-readable name for messages, e.g. `origin/main`. */
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
        return readFileSync(join(cwd, path))
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
        // Absent at this revision -- a file this change added.
        return undefined
      }
    },
  }
}

/** The base branch could not be resolved. Only fatal in `mode: ratchet`. */
export class BaseRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BaseRefError'
  }
}

const FETCH_DEPTH_HINT = [
  'Comparing against the base branch needs it in this clone.',
  'Add fetch-depth: 0 to your checkout step:',
  '',
  '    - uses: actions/checkout@v5',
  '      with:',
  '        fetch-depth: 0',
].join('\n')

function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

export interface BaseRevisionOptions {
  cwd: string
  /** Branch name, e.g. `main` -- typically GITHUB_BASE_REF. */
  baseRef: string
  /** Attempt a fetch when the ref is missing. On in CI, off locally. */
  allowFetch?: boolean
  onNotice?: ((message: string) => void) | undefined
}

export interface BaseResolution {
  revision?: string
  /**
   * Why there is no revision, phrased for a human. Returned rather than thrown
   * because whether it is fatal depends on the mode, and that is the caller's
   * call to make, not this function's.
   */
  problem?: string
}

/**
 * Resolve the revision to compare against.
 *
 * Prefers the merge base over the base tip: comparing against the tip
 * attributes everything that landed on the base branch since you branched to
 * your change, in both directions, which is exactly the unfair complaint this
 * comparison exists to avoid.
 */
export function resolveBaseRevision(options: BaseRevisionOptions): BaseResolution {
  const { cwd, baseRef, allowFetch = false, onNotice } = options
  if (!baseRef) return { problem: 'no base branch to compare against' }

  const candidates = [`origin/${baseRef}`, baseRef, `refs/remotes/origin/${baseRef}`]
  const verify = (ref: string): boolean =>
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd) !== undefined

  let resolved = candidates.find(verify)

  if (!resolved && allowFetch) {
    onNotice?.(`base ref "${baseRef}" is not in this clone; fetching it`)
    git(
      ['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`],
      cwd,
    )
    resolved = candidates.find(verify)
  }

  if (!resolved) {
    return { problem: `could not resolve the base branch "${baseRef}".\n\n${FETCH_DEPTH_HINT}` }
  }

  const mergeBase = git(['merge-base', resolved, 'HEAD'], cwd)
  if (mergeBase) return { revision: mergeBase }

  // Shallow clones often have the branch tip but not enough history to find a
  // merge base. Comparing against the tip is still far better than nothing.
  onNotice?.(
    `no merge base between ${resolved} and HEAD (likely a shallow clone); ` +
      `comparing against ${resolved} directly. Set fetch-depth: 0 for an exact comparison.`,
  )
  return { revision: resolved }
}

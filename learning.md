# learning.md

The TypeScript and Node techniques used in this repo, for an iOS developer new to both.
Every snippet is real code from `src/`.

---

## 1. The toolchain

| Here | Your world |
|---|---|
| Node.js | Swift runtime + Foundation (`node:fs`, `node:path`, `node:child_process`) |
| `npm` | SwiftPM + a task runner |
| `package.json` | `Package.swift` plus named commands |
| `package-lock.json` | `Package.resolved` (committed) |
| `node_modules/` | `.build/checkouts/` (gitignored) |
| `tsconfig.json` | compiler / build settings |
| `.nvmrc` | `.swift-version` (pins Node 24.4.1) |
| `vitest` | XCTest |
| `dist/index.js` | the shipped binary (committed, see §7) |

```bash
npm ci               # install exactly the lockfile
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run build        # ncc bundle -> dist/
npm run all          # all three, what CI runs
```

`scripts` in `package.json` are just shell aliases; `npm run` puts `node_modules/.bin` on `PATH`.
`dependencies` get inlined into the shipped bundle, `devDependencies` don't.

---

## 2. tsconfig flags that change how you write code

```jsonc
"strict": true,                   // includes strictNullChecks. Never turn off.
"noUncheckedIndexedAccess": true, // arr[i] is T | undefined
"module": "NodeNext",             // real ES modules
"skipLibCheck": true,             // don't typecheck node_modules
"forceConsistentCasingInFileNames": true  // macOS is case-insensitive, Linux CI isn't
```

**`strict`** is what makes optionals behave like Swift's at all. Without `strictNullChecks`,
`string` silently includes `null`/`undefined` and the type system is decorative.

**`noUncheckedIndexedAccess`** is the opposite of Swift:

```swift
let x: Int = array[5]          // non-optional type; traps at runtime
```
```ts
const x: number | undefined = array[5]   // optional type; NEVER traps, hands you undefined
```

JS returns `undefined` out of bounds, which propagates as `NaN` three functions away. This flag
surfaces it. It's why you see escape hatches like this in `line-index.ts`, where a binary search has
already established the bounds:

```ts
if ((starts[mid] as number) <= offset) lo = mid
```

**`as` is not a cast.** It emits no code and does no check, so a wrong `as` doesn't crash there, it
corrupts data later. Closer to `unsafeBitCast` than to `as?`.

---

## 3. ES modules and the `.js` import quirk

`"type": "module"` in `package.json` means ES modules, so:

```ts
// the file on disk is core/analyze.TS, but we import .JS
import { analyze, type AnalysisResult } from './core/analyze.js'
```

You import the path of the *compiled output*. Node resolves ESM specifiers literally and won't guess
an extension. Mechanical rule: **every relative import ends in `.js`**, always.

`import type` compiles to nothing:

```ts
import type { ReportInput } from './report/model.js'
```

Which is why `lint.ts` and `report/model.ts` import each other's types — a circular import that is
fine because neither direction survives to runtime. Make either one a value import and it breaks.

---

## 4. Types

```ts
type LanguageCode = string                     // typealias
type Severity = 'error' | 'warn' | 'off'       // union of literals ~ a simple enum
type ReportedSeverity = 'error' | 'warn'       // a SUBTYPE of Severity, no conversion needed

interface Issue {
  class: IssueClass
  severity: ReportedSeverity
  key: string
  language?: LanguageCode    // optional property
  loc: SourceLocation
}
```

Union subsetting is free: an `Issue.severity` (never `'off'`) flows into anything wanting a
`Severity`. In Swift you'd write two enums and a mapping function.

**Structural typing.** If the shape fits, it's compatible — no conformance declaration:

```ts
interface Substitution extends ValueNode { argNum?: number }
```

Anything with `{ unit?, variations?, loc }` *is* a `ValueNode`, so `collectLeaves(node: ValueNode)`
is one small walker used by four unrelated callers.

**Built-in type transforms** (no Swift equivalent):

```ts
Omit<Issue, 'severity' | 'catalog'>   // Issue minus those keys
Partial<T>  Pick<T,K>  Record<K,V>  Readonly<T>
```

`rules/rule.ts` uses `Omit` to make the architecture unrepresentable to violate — a rule literally
*cannot* set its own severity, because the field doesn't exist on the type it returns.

---

## 5. Optionals and narrowing

JS has two absences (`undefined`, `null`) and forces you to unwrap nothing. The mechanism that
replaces `if let` is **narrowing**: the compiler tracks what a check proved.

```ts
const localization = entry.localizations[language]   // Localization | undefined
if (!localization) return []                          // early return narrows
return collectLeaves(localization)                    // here it's Localization
```

Same shape as `guard let`, no new binding. Works through `if`, `&&`, `return`, `throw`, `typeof`,
`instanceof`, `Array.isArray`.

`a?.b` and `a ?? b` behave as in Swift. But **`??` and `||` differ**: `??` fires only on
null/undefined, `||` fires on any falsy value (`0`, `''`, `false`, `NaN`). `threshold || 100` would
turn a legitimate `0` into `100`. This repo uses `||` only where empty-string-means-absent is
correct (`get('mode') || ''`) and `??` everywhere else.

---

## 6. Record, Map, Set, and identity

```ts
Record<string, Localization>   // plain object used as a dictionary; what JSON parses into
Map<string, Catalog>           // the real hash map: any key type, .size, insertion order
Set<string>
```

The repo uses `Record` for the parsed domain model and `Map` for working state inside functions.

### The one that will bite you: Set/Map compare objects by identity

Swift structs are values, so `Set<Issue>` compares by `Hashable`. In JS **every object literal is a
reference**, and `Set`/`Map` compare objects by pointer. There is no way to make them content-based.

`lint.ts` depends on this deliberately:

```ts
const blocking = gated.filter((issue) => issue.severity === 'error')
const blockingSet = new Set(blocking)
nonBlocking: result.issues.filter((issue) => !blockingSet.has(issue)),
```

`filter` copies the array, not the elements, so `blocking` holds the *same objects* as
`result.issues` and `.has()` correctly answers yes with no equality implementation. It also means a
single `{...issue}` anywhere in that path would silently break the partitioning.

When content equality is actually needed, build an explicit key:

```ts
return JSON.stringify([issue.catalog, issue.key, issue.language ?? null, group])
```

`JSON.stringify` of an array, not string concatenation, because `"a/b" + ":" + "c"` and
`"a" + ":" + "b/c"` collide and a path or key can contain any character. This is the JS equivalent
of writing a careful `Hashable`.

---

## 7. `as const`: deriving types from values

Types are erased at runtime, so when you need both a runtime list and a compile-time union you go
value → type (Swift's `CaseIterable` goes the other way):

```ts
export const STATE_ISSUE_CLASSES = ['missing', 'empty', 'new', 'needsReview', 'stale'] as const
export type StateIssueClass = (typeof STATE_ISSUE_CLASSES)[number]
//                            ^ element type of that tuple = the union of its 5 literals
```

Without `as const` the array widens to `string[]` and you get `string`. This is the most important
idiom in `types.ts`: iterate the array at runtime, get exhaustiveness at compile time, one source of
truth. Adding an issue class makes the compiler point at every `Record<IssueClass, string>` that
needs a new entry.

**`satisfies`** checks without widening:

```ts
const DEFAULT_CHECK_SEVERITY = {
  formatSpecifier: 'error',
  pluralCoverage: 'warn',
} as const satisfies Partial<Record<IssueClass, Severity>>
```

With `: Partial<Record<...>>` instead, every value would widen to `Severity` and you'd lose the fact
that `formatSpecifier` is specifically `'error'`. `satisfies` catches typos without the information
loss.

**`(string & {})`** is the open-enum trick:

```ts
type UnitState = 'translated' | 'new' | 'needs_review' | 'stale' | (string & {})
```

"Any string, but autocomplete these four." Plain `string` would work but lose autocomplete; the
`& {}` stops the union collapsing. Used because a future Xcode adding a fifth state must not crash
the parser.

**Exhaustive switches** are checked indirectly:

```ts
function stateMessage(stateClass: StateIssueClass): string {
  switch (stateClass) {
    case 'missing': return `...`
    // ... all five, no default
  }
}
```

No `default`, declared return type `string`. Add a sixth class and you get *"not all code paths
return a value"*. Adding a `default` silences the check forever.

---

## 8. Errors

There is **no `throws` in a signature**. Any function can throw anything, and the compiler won't
tell you. No `try?`, no `Result`.

```ts
try {
  text = readFileSync(path, 'utf8')
} catch (error) {                                       // error is `unknown`, not Error
  const code = (error as NodeJS.ErrnoException).code    // you narrow it yourself
  if (code === 'ENOENT' && !explicit) return defaultConfig()
  throw new ConfigError(`could not read ${path}: ${(error as Error).message}`)
}
```

Since the compiler gives you nothing, the discipline is structural: **catch in one place, let types
decide the outcome.** A `class` gives you `instanceof`, which is nominal, and `main.ts` switches on
it:

```ts
try { await runAction() }
catch (error) {
  if (error instanceof ConfigError || error instanceof BaseRefError) return misconfigured(error.message)
  if (error instanceof CatalogParseError) return misconfigured(`${error.file}: ${error.message}`)
  core.setFailed(error instanceof Error ? error.stack || error.message : String(error))
}
```

```ts
export class CatalogParseError extends Error {
  readonly file: string
  constructor(file: string, message: string) {
    super(message)
    this.name = 'CatalogParseError'   // JS does not set this for you; stack traces read it
    this.file = file
  }
}
```

**`unknown` vs `any`:** `any` means "stop checking" and spreads through everything it touches.
`unknown` means "I don't know yet" and forces you to narrow (Swift's `Any`). This repo uses
`unknown` at trust boundaries and effectively never uses `any`.

---

## 9. Runtime validation: types are erased

The single biggest consequence of TS having no runtime types. There is no `Codable` — parsing YAML
gives you `unknown` and the type system cannot help. **zod** is the answer: a schema built at
runtime, from which the static type is derived.

```ts
const fileSchema = z.object({
  paths: z.array(nonEmptyString).min(1, 'must list at least one glob').optional(),
  failOn: z.array(stateClassSchema).optional(),
  formatSpecifiers: severitySchema.optional(),
}).strict()

export type ConfigFile = z.infer<typeof fileSchema>   // static type, derived from the value
```

One declaration, both a validator and a type, and they cannot disagree. `.strict()` rejects unknown
keys, so a typo like `failon:` is an error rather than a silently ignored setting.

---

## 10. Async

```ts
async function postComment(body: string, token: string): Promise<void> { await octokit... }
void main()   // "I know this returns a promise and I'm deliberately not awaiting it"
```

`Promise<T>` is Swift's `async` return; `await` is `await`. Differences: **single-threaded** (one
event loop, so no data races by construction and no actors), and no structured concurrency or
cancellation. Note how little of this repo is async — only the GitHub API call and the summary
write. All the linting is synchronous, which is what makes it testable as a plain function call.

---

## 11. The libraries, one line each

| Package | What it does | Why not roll your own |
|---|---|---|
| `zod` | runtime schema validation | types are erased; something has to check |
| `yaml` | parse the config | typed `YAMLParseError.linePos` gives error line numbers |
| `jsonc-parser` | JSON to a syntax tree **with byte offsets** | `JSON.parse` throws positions away, and annotations that point at line 1 are useless |
| `fast-glob` | `**/*.xcstrings` on disk | correct glob semantics + skipping `node_modules` |
| `picomatch` | glob matching with **no filesystem** | needed for `git ls-tree` output, which is just strings |
| `@actions/core` | inputs, outputs, annotations, job summary | the protocol is stdout magic strings; escaping is easy to get wrong |
| `@actions/github` | authenticated Octokit + event payload | pagination, auth, rate limits |
| `@vercel/ncc` (dev) | bundles everything into one file | see below |

Deliberately *not* a dependency: CLDR plural data. `cldr-plurals.ts` is a hand-maintained ~60-line
table, because a real CLDR package would be megabytes in the bundle for one lookup.

---

## 12. Node APIs used

```ts
readFileSync(path, 'utf8')            // sync file read; returns string with encoding, Buffer without
Buffer                                // byte array, ~ Data. Used for UTF-16 detection in .strings
buffer.subarray(2).toString('utf16le')
Buffer.from(x).swap16()               // big-endian to little-endian
execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', rev], { cwd, encoding: 'utf8' })
process.exitCode = 2                  // NOT process.exit(2)
```

Two things worth knowing:

- **`execFileSync`, not `exec`.** It takes an argv array and spawns **no shell**, so a branch name
  containing `;` is data, not code. Same idea as parameterised SQL.
- **`process.exitCode = 2`, not `process.exit(2)`.** Setting the property lets stdout flush and
  pending work finish before exiting; `process.exit()` terminates immediately and can truncate your
  output.

---

## 13. Testing with Vitest

| Vitest | XCTest |
|---|---|
| `describe('...', () => {})` | a test class |
| `it('...', () => {})` | `func testX()` |
| `expect(x).toBe(y)` | `XCTAssertEqual` |
| `expect(x).toEqual(y)` | deep structural equality |
| `expect(x).toMatchSnapshot()` | no equivalent |

**Injection over mocking.** There is no mocking library in the repo; the seams are plain parameters:

```ts
export type InputReader = (name: string) => string
export function readInputs(get: InputReader): ActionInputs   // never imports @actions/core

analyze(catalogs, config, { rules?: readonly Rule[] })       // "injected by tests"
```

**Real files when the code reads files.** A temp dir, a callback, `finally` cleanup — no `fs` mock,
because encoding detection and glob behaviour are exactly the things most likely to be wrong:

```ts
const dir = mkdtempSync(join(tmpdir(), 'xcstrings-lint-'))
try { /* write files */ body(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
```

**Snapshots** for rendered Markdown (`__snapshots__/*.snap`). Update with `npx vitest -u`, and read
the diff — a snapshot you update without reading is a test you deleted.

---

## 14. Shipping: why `dist/` is committed

GitHub Actions **does not build JavaScript actions**. It clones the repo and runs `node
dist/index.js` immediately, with no `npm install`. So `ncc` bundles `src/main.ts` plus every runtime
dependency into one 2.2 MB `dist/index.js`, and that file is committed. Conceptually: static
linking.

The failure mode with no iOS analogue is **`dist/` drifting from `src/`**, so the action silently
runs yesterday's code. CI guards it by rebuilding and diffing:

```bash
git diff --quiet --exit-code dist/ || exit 1
```

**So: after changing `src/`, run `npm run build` and commit `dist/` in the same commit.**

Also in `.gitattributes`:

```
dist/** -diff linguist-generated=true    # committed, but out of diffs and language stats
__tests__/fixtures/** -text              # byte-sensitive: tests cover UTF-16 and BOMs
```

---

## 15. Gotchas

- **`.js` in every relative import**, even though the file is `.ts`.
- **`===`, never `==`.** `==` coerces (`'' == 0` is `true`).
- **`arr[i]` is `T | undefined`** and never traps.
- **`sort()` mutates in place.** Copy first: `[...xs].sort(...)`.
- **`Set`/`Map` compare objects by identity**, never content.
- **`0`, `''`, `NaN`, `false` are falsy.** `if (count)` is a bug when `0` is meaningful.
- **No `throws` in signatures.** Catch centrally.
- **`catch (e)` gives `unknown`.** Narrow it yourself.
- **`as` does no runtime check.**
- **Types are erased.** Trust boundaries need a real runtime check.

# learning.md

A guided tour of this repository for an iOS developer who has never written TypeScript.

Everything is explained twice: once as "what this is in the JS/TS world", once as "the Swift/Xcode
thing you already know". Then we walk the actual code and, more importantly, **why it is shaped the
way it is** — most of the interesting decisions in this repo are judgement calls, not syntax.

**Contents**

1. [What this project actually is](#1-what-this-project-actually-is)
2. [The toolchain: Node, npm, tsconfig](#2-the-toolchain-node-npm-tsconfig)
3. [TypeScript for a Swift developer](#3-typescript-for-a-swift-developer)
4. [The architecture: one pipeline, five stages](#4-the-architecture-one-pipeline-five-stages)
5. [File-by-file walkthrough](#5-file-by-file-walkthrough)
6. [The dependencies, and why each one earns its place](#6-the-dependencies-and-why-each-one-earns-its-place)
7. [Testing](#7-testing)
8. [The GitHub Actions layer](#8-the-github-actions-layer)
9. [The design principles this codebase actually follows](#9-the-design-principles-this-codebase-actually-follows)
10. [Working on it day to day](#10-working-on-it-day-to-day)
11. [Cheat sheet](#11-cheat-sheet)

---

## 1. What this project actually is

A **GitHub Action**: a program that GitHub runs inside a CI job. Not a library, not an app, not a
server. Its whole life is:

```
process starts → read env vars + inputs → read files → print stuff → exit with a code
```

The exit code *is* the product. `0` = green check on the PR, non-zero = red X.

**What it checks.** Xcode's `.xcstrings` String Catalog is just JSON. Xcode shows you a completion
percentage in the editor and *never fails your build*. So the standard failure story is: a string
gets added, translated into two languages, and ships to the other eight locales as a raw key ID.
This action reads every catalog in the repo and fails the PR on that.

**Why TypeScript and not Swift.** GitHub Actions has a first-class JavaScript runtime (`node20`)
baked into every runner. A JS action starts in ~100 ms on `ubuntu-latest`. A Swift action would mean
either a Docker action (~30 s of image pull per run) or a macOS runner (10× the billing minutes).
And `.xcstrings` is JSON — you do not need any Apple toolchain to read it. That single observation
("it's just JSON") is what makes the whole project cheap.

**The mental model shift.** In iOS you ship a binary to a device and the OS runs it. Here you ship a
*source repository* and GitHub runs it. There is no build step on GitHub's side — which is why
`dist/` is committed to git. More on that in §8.

---

## 2. The toolchain: Node, npm, tsconfig

### The map

| This repo | Your world | Notes |
|---|---|---|
| Node.js | the Swift runtime + Foundation | The JS engine plus a stdlib (`node:fs`, `node:path`, `node:child_process`) |
| `npm` | SwiftPM + Xcode's build system | Dependency resolver *and* task runner |
| `package.json` | `Package.swift` + scheme settings | Metadata, deps, and named commands |
| `package-lock.json` | `Package.resolved` | Exact resolved versions. Committed. |
| `node_modules/` | `.build/checkouts/` or `Pods/` | Downloaded source. Gitignored. |
| `tsconfig.json` | build settings / compiler flags | Strictness, target, module system |
| `.nvmrc` | `.swift-version` | Pins the Node version (24.4.1 here) |
| `npm run <x>` | a scheme or a `Makefile` target | Defined in `package.json` `scripts` |
| `vitest` | XCTest / Swift Testing | The test runner |
| `dist/index.js` | your shipped `.app` binary | One bundled file, committed |

### `package.json`, annotated

```jsonc
{
  "name": "xcstrings-lint",
  "version": "2.1.0",
  "private": true,          // never publish to npm; we ship via a git tag instead
  "engines": { "node": ">=20" },
  "type": "module",         // ← IMPORTANT. See "the two module systems" below.

  "scripts": {
    "build":     "ncc build src/main.ts -o dist --target es2022 --license licenses.txt",
    "typecheck": "tsc --noEmit",
    "test":      "vitest run",
    "test:watch":"vitest",
    "all":       "npm run typecheck && npm run test && npm run build"
  },

  "dependencies":    { /* shipped inside dist/index.js */ },
  "devDependencies": { /* only needed to build and test */ }
}
```

Two things worth pausing on:

**`scripts` are just shell aliases.** `npm run typecheck` runs `tsc --noEmit`. There is no magic —
`npm run` puts `node_modules/.bin` on `PATH` and executes the string. `npm run all` is the local
equivalent of "run CI before I push".

**`dependencies` vs `devDependencies`** is the same split as a SwiftPM target dependency vs a test
target dependency. Here it matters more than usual, because `dependencies` end up *inlined into the
shipped bundle* (§8), so every one of them costs bundle size on every action run.

### `tsconfig.json`, annotated

This file is the closest thing to your Xcode build settings, and this repo turns the strictness
knobs up a long way. Every flag here is a decision.

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",              // what JS to emit. Node 20+ supports it all natively.
    "lib": ["ES2022"],               // which built-in APIs exist. No "DOM" → no window/document.
    "module": "NodeNext",            // emit real ES modules, resolved the way Node does
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "lib",                 // only used by a plain `tsc` build; the real build uses ncc

    "strict": true,                  // ← the big one; see below
    "noUncheckedIndexedAccess": true,// ← the surprising one; see below
    "noImplicitOverride": true,      // must write `override` when overriding, like Swift
    "exactOptionalPropertyTypes": false,
    "esModuleInterop": true,         // let ESM import old CommonJS packages cleanly
    "forceConsistentCasingInFileNames": true,  // macOS is case-insensitive, Linux CI is not
    "skipLibCheck": true,            // don't typecheck inside node_modules — huge speedup
    "resolveJsonModule": true,
    "types": ["node"]                // pull in @types/node so `node:fs` etc. are typed
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "lib"]
}
```

**`strict: true`** turns on ~8 sub-flags at once. The important one is `strictNullChecks`, which is
what makes TypeScript's optionals behave like Swift's at all. Without it, `string` silently includes
`null` and `undefined` and the type system is decorative. **Never turn this off.**

**`noUncheckedIndexedAccess: true`** is the flag that will surprise you most, because it is the
opposite of Swift:

```swift
// Swift: subscripting out of bounds is a runtime trap. Type is non-optional.
let x: Int = array[5]          // compiles; may crash
```
```ts
// TypeScript with this flag: subscripting is typed as possibly-undefined.
const x: number | undefined = array[5]   // compiles; x may be undefined at runtime
```

JavaScript does *not* trap on out-of-bounds — it hands you `undefined`, which then propagates as
`NaN` or `"undefined"` somewhere three functions away. This flag surfaces that in the type system.
It is why you see this in [`line-index.ts`](src/core/parse/line-index.ts):

```ts
if ((starts[mid] as number) <= offset) lo = mid
```

The `as number` is a deliberate escape hatch: this is a binary search whose bounds were just
established, so the author is asserting what the compiler can't prove. Same reason for
`value[i] as string` in the parsers. **`as` is `unsafelyUnwrapped`, not `as!`** — it does no runtime
check at all, so a wrong `as` doesn't crash there, it corrupts data later. Use it only where you can
point at the line that guarantees it.

**`exactOptionalPropertyTypes: false`** is set to `false`, but the codebase is written *as if it were
true*. Look at this pattern, which appears dozens of times:

```ts
return {
  key,
  ...(comment === undefined ? {} : { comment }),   // spread nothing, or spread one key
  shouldTranslate: boolProp(node, 'shouldTranslate') ?? true,
}
```

That is: "include the `comment` property only if there is a comment", rather than
`comment: undefined`. The distinction is invisible to Swift developers because Swift has no such
thing — but in JS, `{a: 1}` and `{a: 1, comment: undefined}` behave differently under
`JSON.stringify`, `Object.keys`, and `'comment' in obj`. Writing it this way keeps the objects
genuinely clean, and means flipping the flag to `true` later would not require rewriting anything.

### The two module systems (the thing that will confuse you first)

JavaScript has two incompatible import systems, for historical reasons:

| | CommonJS (old) | ES Modules (modern) |
|---|---|---|
| import | `const x = require('y')` | `import x from 'y'` |
| export | `module.exports = x` | `export const x = ...` |
| opt in | default | `"type": "module"` in package.json |

This repo is **ESM** (`"type": "module"`). Which produces the single weirdest thing in the codebase:

```ts
// src/lint.ts — the file on disk is core/analyze.TS, but we import .JS
import { analyze, type AnalysisResult } from './core/analyze.js'
```

**You import the path of the compiled output, not the source.** Node resolves ESM specifiers
literally — it will not guess an extension — so the specifier has to be what will exist at runtime
(`.js`). TypeScript deliberately does not rewrite it. Once you know it, it's mechanical: *every
relative import in this repo ends in `.js`, always, even though no `.js` file exists in `src/`.*

Also note the `type` keyword inside that import. See §3.

---

## 3. TypeScript for a Swift developer

TypeScript is a *type checker that erases itself*. `tsc` checks your types and then emits JavaScript
with every type annotation deleted. There is no runtime type information whatsoever — no
`Mirror`, no `is`/`as?` on your own types, no `Codable`. That single fact explains several design
choices later in this document (zod, `as const` arrays, the `Set` identity trick).

### The type-level basics

```ts
// Type alias — like Swift's `typealias`, but far more powerful
type LanguageCode = string

// Union of literals — the closest thing to a simple Swift enum
type Severity = 'error' | 'warn' | 'off'

// Subsetting a union just works, structurally. No conversion needed.
type ReportedSeverity = 'error' | 'warn'          // assignable to Severity
```

In Swift you would write two enums and a mapping function. Here `ReportedSeverity` is *literally a
subtype* of `Severity`, so an `Issue.severity` (which can never be `'off'`) flows into anything
expecting a `Severity` for free. This repo uses that a lot — see [`types.ts`](src/core/types.ts).

```ts
// interface — describes the SHAPE of an object. Roughly a Swift struct/protocol hybrid.
export interface Issue {
  class: IssueClass
  severity: ReportedSeverity
  catalog: string
  key: string
  language?: LanguageCode   // optional property
  loc: SourceLocation
  message: string
  detail?: string
}
```

### Optionals: the biggest single difference

Swift has one absence (`nil`) and forces you to unwrap. JavaScript has **two** absences and forces
you to unwrap *nothing*.

| | Swift | TypeScript |
|---|---|---|
| "declared, no value" | `nil` | `undefined` |
| "explicitly empty" | — | `null` |
| unwrap | `if let`, `guard let`, `!`, `?.` | just use it after a check |
| optional chain | `a?.b` | `a?.b` (same) |
| default | `a ?? b` | `a ?? b` (same) |

The mechanism that replaces `if let` is **narrowing** (a.k.a. control-flow analysis). The compiler
tracks what a check proved:

```ts
const localization = entry.localizations[language]   // Localization | undefined
if (!localization) return []                          // early return narrows it
return collectLeaves(localization)                    // here it is Localization. No unwrap needed.
```

The variable does not change type — the *compiler's belief about it in this branch* does. Compare:

```swift
guard let localization = entry.localizations[language] else { return [] }
return collectLeaves(localization)
```

Same shape, no new binding. Narrowing works through `if`, `&&`, `return`, `throw`, `typeof`,
`instanceof`, and `Array.isArray`.

**`??` vs `||`.** `??` fires only on `null`/`undefined`. `||` fires on any *falsy* value — `0`,
`''`, `false`, `NaN` included. That's a real bug source: `threshold || 100` would turn a legitimate
`threshold: 0` into `100`. This repo uses `||` deliberately in [`inputs.ts`](src/action/inputs.ts)
where empty-string-means-absent is exactly right (`get('mode') || ''`), and `??` everywhere a zero
or empty string is a legitimate value.

### Records, Maps and Sets

```ts
Record<string, Localization>   // ≈ [String: Localization]  — a plain object used as a dictionary
Map<string, Catalog>           // ≈ [String: Catalog]        — a real hash map
Set<string>                    // ≈ Set<String>
```

`Record<K, V>` is a plain JS object. It's what JSON parses into, so it's the natural shape for
parsed data. But it has sharp edges: keys are always strings, and `Object.keys()` order is
insertion order (which this repo actually relies on — see the parser). `Map` is the real data
structure: any key type, guaranteed insertion order, a proper `.size`, and no prototype pollution.

The repo picks deliberately: `Record` for the parsed domain model (`localizations`,
`substitutions`), `Map` for working state inside functions (`byKey`, `tally`, `rows`).

`Set` matters a lot here, for a reason that will bite you if you think in Swift — see below.

### 🔴 Reference semantics: `Set<Issue>` is identity-based

Swift structs are values. `Set<Issue>` in Swift would compare by `Hashable`, i.e. by content. In
JavaScript, **every object literal is a reference**, and `Set`/`Map` compare objects by *identity*
(pointer equality), never by content. There is no way to make a JS `Set` content-based.

This codebase leans on that on purpose. From [`lint.ts`](src/lint.ts):

```ts
const blocking = gated.filter((issue) => issue.severity === 'error')
const blockingSet = new Set(blocking)
// ...
nonBlocking: result.issues.filter((issue) => !blockingSet.has(issue)),
```

`blocking` holds *the very same objects* that are in `result.issues` (`filter` copies the array, not
the elements). So `blockingSet.has(issue)` is asking "is this the same object I put in the set?" —
and it correctly answers yes, without needing any equality implementation. Same trick in
[`model.ts`](src/report/model.ts) for `carriedIssues`/`warningIssues`.

This is elegant, and it is also fragile in a specific way: if any stage ever *copied* an issue
(`{...issue}`), the identity would break and the partitioning would silently go wrong. That is why
`compare.ts` deliberately passes through the original objects, and why `analyze` builds each issue
exactly once. Worth knowing before you refactor anything in that path.

When you *do* need content equality, the repo builds an explicit string key:

```ts
// compare.ts — a stable identity for an issue, across two different parses
export function issueIdentity(issue: Issue): string {
  const group = /* five state classes collapse to 'state' */
  return JSON.stringify([issue.catalog, issue.key, issue.language ?? null, group])
}
```

`JSON.stringify` of an array, not string concatenation — because `"a/b" + ":" + "c"` and
`"a" + ":" + "b/c"` collide, and a catalog path or a translation key can contain any character. This
is the JS equivalent of writing a careful `Hashable` conformance.

### `as const` and deriving types from values

Because types don't exist at runtime, you often need *both* a runtime list and a compile-time union.
Swift gives you both from one enum via `CaseIterable`. TypeScript makes you go value → type:

```ts
// types.ts
export const STATE_ISSUE_CLASSES = ['missing', 'empty', 'new', 'needsReview', 'stale'] as const
export type StateIssueClass = (typeof STATE_ISSUE_CLASSES)[number]
//                            ^ "the element type of that tuple" = the union of its 5 literals
```

Without `as const`, TypeScript widens the array to `string[]` and you'd get `string`. With it, the
array is a `readonly` tuple of exact literals, and indexing it with `[number]` gives you the union.

This is the single most important idiom in the file. It gives you one source of truth: iterate
`ALL_ISSUE_CLASSES` at runtime (the config resolver, the report renderer, and the annotation planner
all do), and get exhaustiveness checking at compile time from the same declaration. Adding an issue
class is a one-line change *and* the compiler then tells you every switch and every `Record<IssueClass, …>`
that needs a new case — [`CLASS_LABELS`](src/report/model.ts), [`TITLES`](src/report/annotations.ts),
`DEFAULT_CHECK_SEVERITY`, and so on.

### Exhaustive switches (and how TS actually checks them)

```ts
function stateMessage(stateClass: StateIssueClass, language: string, detail?: string): string {
  switch (stateClass) {
    case 'missing':    return `no ${language} translation`
    case 'empty':      return `${language} translation is empty`
    case 'new':        return `${language} is marked new`
    case 'needsReview':return `${language} is marked needs_review`
    case 'stale':      return `${language} is marked stale`
  }   // ← no default, on purpose
}
```

Swift's compiler says "switch must be exhaustive". TypeScript's mechanism is *indirect*: the return
type is declared `string`, there is no `default`, so if you add a sixth class the switch can fall
through and the compiler errors with **"not all code paths return a value"**. Same protection,
different error message. The `default` case is omitted deliberately — adding one would silence the
check forever.

### `satisfies` — check without widening

```ts
const DEFAULT_CHECK_SEVERITY = {
  formatSpecifier: 'error',
  pluralCoverage: 'warn',
  duplicateKey: 'error',
  // ...
} as const satisfies Partial<Record<IssueClass, Severity>>
```

Read it as: "verify this literal conforms to that type, but keep its precise literal type." With
`: Partial<Record<…>>` instead, every value would widen to `Severity` and you'd lose the fact that
`formatSpecifier` is specifically `'error'`. `satisfies` gives you the typo-catching of an
annotation without the information loss. It also catches a misspelled key — `formatSpecifiers`
(plural) would fail to compile here, which is exactly the bug you want caught.

### `(string & {})` — the "open enum" trick

```ts
export type UnitState = 'translated' | 'new' | 'needs_review' | 'stale' | (string & {})
```

This means "any string, but autocomplete these four". Why: Xcode writes those four states today, but
the format doesn't forbid others, and a future Xcode adding a fifth must not crash the parser.
Plain `string` would work but lose all autocomplete and all documentation value. `(string & {})` is
a compiler quirk that stops the union collapsing to `string` while still accepting any string. Same
pattern on `ExtractionState`.

There is no Swift equivalent — this is the closest you get to a non-frozen enum you can still switch
on comfortably.

### Structural typing (nominal typing is gone)

Swift is nominal: two structs with identical fields are unrelated types. TypeScript is
**structural**: if the shape fits, it's compatible.

```ts
interface Substitution extends ValueNode { argNum?: number; formatSpecifier?: string }
```

Anything with `{ unit?, variations?, loc }` *is* a `ValueNode`, whether it says so or not. So a
`Substitution` and a `Localization` both flow into `collectLeaves(node: ValueNode)` with no
protocol conformance, no `extends`, nothing. That is why `value-node.ts` can be one small generic
walker used by four different callers.

The cost: two unrelated concepts that happen to share a shape are silently interchangeable. The
mitigation this repo uses is the `class` for errors:

```ts
export class CatalogParseError extends Error {
  readonly file: string
  constructor(file: string, message: string, line?: number, column?: number) {
    super(message)
    this.name = 'CatalogParseError'   // ← set by hand; JS does not do this for you
    this.file = file
  }
}
```

A `class` gives you `instanceof`, which *is* nominal — and `instanceof` is what
[`main.ts`](src/main.ts) switches on to map errors to exit codes. Setting `this.name` matters
because JS derives it from the prototype, not the class declaration, and stack traces read it.

### Errors are exceptions, not `throws`

There is **no `throws` in a TypeScript signature**. Any function can throw anything (including a
string, or `undefined`), and the compiler will not tell you. There is no `try?`, no
`Result` in the stdlib, no typed error propagation.

```ts
try {
  text = readFileSync(path, 'utf8')
} catch (error) {                                        // `error` is `unknown`, not `Error`
  const code = (error as NodeJS.ErrnoException).code     // you narrow it yourself
  if (code === 'ENOENT' && !explicit) return defaultConfig()
  throw new ConfigError(`could not read config file ${path}: ${(error as Error).message}`)
}
```

Because the compiler gives you nothing here, the discipline has to be structural. This repo's answer
is: **catch at exactly one place, and let types decide the exit code.** All of `main.ts`'s error
handling is a single `try` around the whole run:

```ts
async function main(): Promise<void> {
  try { await runAction() }
  catch (error) {
    if (error instanceof ConfigError || error instanceof BaseRefError) return misconfigured(error.message)
    if (error instanceof CatalogParseError) return misconfigured(`${error.file}: ${error.message}`)
    core.setFailed(error instanceof Error ? error.stack || error.message : String(error))
  }
}
```

Three custom error classes, three exit-code meanings, one place that maps between them. Every
"you configured this wrong" path — including ones that fire while reading inputs, before the run
starts — lands on exit 2 because it throws a `ConfigError` and this catch is the only handler.

### `unknown` vs `any`

| | meaning |
|---|---|
| `any` | "stop checking". Poison — it spreads through every expression it touches. |
| `unknown` | "I don't know yet". Safe: you must narrow before using it. ≈ Swift's `Any`. |

The repo uses `unknown` for anything crossing a trust boundary (`raw: unknown` from the YAML parser)
and effectively never uses `any`. Treat `any` as a code smell.

### `import type`, and the legal circular import

```ts
import type { ReportInput } from './report/model.js'   // erased at compile time
import { analyze, type AnalysisResult } from './core/analyze.js'  // mixed: value + type
```

`import type` compiles to *nothing*. That has a real consequence here:

- `src/lint.ts` does `import type { ReportInput } from './report/model.js'`
- `src/report/model.ts` does `import type { Mode } from '../lint.js'`

That is a **circular import**, and it is completely fine — because both directions are type-only,
neither survives to runtime, so there is no initialization-order problem. If either became a value
import, you'd get a real runtime cycle. This is a legitimate technique for keeping types next to
what they describe, and it is worth recognising rather than "fixing".

### Async

```ts
async function postComment(body: string, token: string): Promise<void> { … await octokit.… }
void main()   // `void` = "I know this returns a promise and I'm deliberately not awaiting it"
```

`Promise<T>` ≈ Swift's `async` function return. `await` is `await`. The differences from Swift
concurrency: **single-threaded** (one event loop, no data races by construction, no actors needed),
and there is no structured concurrency or cancellation. Note how little of this repo is async —
only the GitHub API call and the job-summary write. All the actual linting is synchronous, which
makes it trivially testable.

---

## 4. The architecture: one pipeline, five stages

```
                 +------------------------------------------------------+
   action.yml    |                     src/main.ts                      |
   inputs   ---> |  the ONLY file that knows GitHub Actions exists       |
                 +----------------------------+-------------------------+
                                              |  LintOptions
                                              v
                 +------------------------------------------------------+
                 |                     src/lint.ts                      |
                 |  the whole check, as one pure-ish function            |
                 +----------------------------+-------------------------+
                                              |
        +--------------+-------------------+---+------------+--------------+
        v              v                   v                v             v
   (1) config.ts  (2) scan.ts        (3) analyze.ts    (4) compare.ts  (5) report/*
   load + valid.   glob + parse      assess + rules    head vs base    markdown
                        |                  |
                   parse/*.ts         assess.ts   <- the shared reading
                   xcstrings          coverage.ts <- the percentage
                   strings            rules/*.ts  <- the 7 checks
```

The five stages, and the one sentence that justifies each boundary:

| Stage | File | Why it is its own layer |
|---|---|---|
| 1. Configure | `core/config.ts` | User input is untrusted; validate it once, at the edge, and never re-read it |
| 2. Scan & parse | `core/scan.ts`, `core/parse/*` | Two file formats normalise into one `Catalog`; nothing downstream knows which |
| 3. Analyze | `core/analyze.ts`, `assess.ts`, `rules/*` | Read each catalog **once**, then run cheap independent checks over that reading |
| 4. Compare | `core/compare.ts` | Answers only "did *I* do this?" — never narrows what gets checked |
| 5. Report | `report/*` | Three output surfaces (comment, job summary, annotations) from one data structure |

### The two decisions that shape everything

**(a) The whole repository is always the scope.** There is no diff mode, no incremental path. From
[`scan.ts`](src/core/scan.ts):

> *The whole tree, every time. What the base branch is used for is telling a developer which of
> these problems they introduced — never for deciding which files to look at, because a translation
> that is missing is missing whether or not this change is what dropped it.*

This is the correct call and it is not the obvious one. A diff-based linter is cheaper and feels
smarter, but it would mean a PR that touches no catalog reports "all clean" on a repo with 400
missing translations. The base branch is used *only* to attribute blame, never to limit scope.

**(b) `passed` is computed in exactly one place.** [`buildReport`](src/lint.ts) is the only function
that decides pass/fail; `exitCodeFor` is the only function that maps a result to `0`/`1`/`2`, and
`main.ts` *asks that same function* rather than re-deriving it:

```ts
// main.ts
if (exitCodeFor(result) === 0) { core.info(`No localization issues ...`); return }
```

```ts
// lint.ts
export function exitCodeFor(result: LintResult): 0 | 1 | 2 {
  if (result.parseErrors.length > 0) return 2
  return result.report.passed ? 0 : 1
}
```

Note the return type: `0 | 1 | 2`, not `number`. The contract is in the type. And because the tests
assert on the same function the action calls, the exit-code behaviour and the tested behaviour
cannot drift apart. This is the single best structural idea in the repo — copy it.

---

## 5. File-by-file walkthrough

### `src/core/types.ts` — the domain model

The vocabulary everything else speaks. Deliberately **format-neutral**: a `.xcstrings` String
Catalog and a folder of `de.lproj/Localizable.strings` files both normalise into a `Catalog`, so no
check ever has to ask which format it came from.

The value tree is the interesting part, because Xcode's format is recursive:

```
CatalogEntry (one key)
 +- localizations: Record<LanguageCode, Localization>
     +- unit?: StringUnit             { state, value }    <- the simple case
     +- variations?: VariationNode[]  plural / device      <- nests: device -> plural is legal
     +- substitutions?: Record<string, Substitution>       <- "%1$#@files@ in %2$#@folders@"
```

Two decisions in here worth calling out:

- **`variations` is a list, not a single node.** Xcode emits one group and nests the rest inside its
  branches, but the format doesn't forbid siblings — and dropping a second group would silently lose
  branches. Handling the case the format allows rather than the case the tool happened to observe.
- **`DuplicateKey` is recorded at parse time, not derived later.** Both formats resolve a
  redeclaration by silently keeping one (JSON is last-wins; so is a legacy table). By the time the
  analyzer sees the `Catalog`, *the evidence is gone*. So the parser has to hand it over. This is a
  genuinely subtle bit of design: a data structure that faithfully represents the resolved state
  cannot also represent the conflict, so the conflict has to travel alongside.

`STATE_PRECEDENCE` deserves a mention too. A unit with `state: "new"` *and* `value: ""` qualifies as
both `new` and `empty`. Reporting both would double-count one missing string and make every total a
lie. So the five state classes are mutually exclusive, resolved by a declared precedence list, and
the *structural* classes (format specifiers, plurals, identical-to-source) are explicitly orthogonal
— a string can be `needs_review` **and** have a broken specifier, and both are real.

### `src/core/config.ts` — untrusted input, validated once

This is where a Swift developer's instincts need adjusting most. In Swift you'd write a `Codable`
struct and get parsing, validation and a type all from one declaration. TypeScript types are erased,
so **decoding YAML gives you `unknown` and the type system cannot help you**.

The answer is **zod**: a schema you build at runtime, from which the static type is *derived*.

```ts
const fileSchema = z.object({
  paths: z.array(nonEmptyString).min(1, 'must list at least one glob').optional(),
  sourceLanguage: nonEmptyString.optional(),
  failOn: z.array(stateClassSchema).optional(),
  ignore: z.object({
    keys: z.array(z.string()).optional(),
    patterns: z.array(nonEmptyString).optional(),
    files: z.array(nonEmptyString).optional(),
  }).strict().optional(),
  formatSpecifiers: severitySchema.optional(),
  // ...
}).strict()

export type ConfigFile = z.infer<typeof fileSchema>   // <- the static type, derived from the value
```

`z.infer<typeof fileSchema>` is the payoff: one declaration, both a runtime validator and a
compile-time type, and they cannot disagree. This is the standard TS answer to `Codable`.

`.strict()` is a deliberate choice: **reject unknown keys**. A typo like `failon:` is an error, not
a silently ignored setting. For a linter, silently ignoring config is the worst possible failure —
the user believes a check is on and it isn't.

Three more decisions in this file:

**An explicit list replaces the default, it doesn't extend it.**
```ts
const failOn = config.failOn ?? DEFAULT_FAIL_ON
```
So `failOn: [missing]` genuinely means *only* `missing` fails. The alternative (merge with defaults)
is friendlier for the common case and impossible to reason about for every other case — you could
never turn a default off.

**Overlap is a config error, not a precedence rule.**
```ts
const overlap = (config.failOn ?? []).filter((c) => (config.warnOn ?? []).includes(c))
if (overlap.length > 0) throw new ConfigError(`... listed in both failOn and warnOn -- pick one`)
```
Listing `missing` in both is a mistake with no sensible interpretation. Picking one silently means
the user gets behaviour they didn't ask for and can't discover.

**Error messages point at the fix, not just the rejection.**
```ts
if (TOP_LEVEL_CHECKS.includes(received)) {
  message = `"${received}" is configured with the top-level "${received}:" option, not in ${where.split('.')[0]}`
}
```
Someone writing `failOn: [formatSpecifiers]` has made an entirely reasonable guess. Telling them
"invalid enum value" is technically correct and useless. That's five lines of code for a large
usability win, and it's the kind of thing that only gets written if you actually try to use your own
tool.

### `src/core/parse/xcstrings.ts` — why not `JSON.parse`?

`.xcstrings` is plain JSON, so `JSON.parse` would work in one line. It isn't used, for exactly one
reason: **`JSON.parse` throws positions away**, and an annotation that points at line 1 is useless.
So the file uses `jsonc-parser`'s `parseTree`, which returns a syntax tree with byte offsets, and
[`LineIndex`](src/core/parse/line-index.ts) maps offsets back to 1-based line/column via binary
search over the line starts.

Everything else in here is defensive reading of a format someone else controls:

```ts
const root = parseTree(text, errors, {
  disallowComments: true,     // .xcstrings is JSON, not JSONC -- be strict about what we accept
  allowTrailingComma: false,
  allowEmptyContent: false,
})
```

```ts
// Insertion-ordered, keyed so a redeclaration REPLACES rather than appends.
const byKey = new Map<string, CatalogEntry>()
// ...
const previous = byKey.get(prop.key)
if (previous) duplicateKeys.push({ key: prop.key, loc, firstLoc: previous.loc })
byKey.set(prop.key, parseEntry(prop.key, prop.value, loc, at))
```

That `Map` does two jobs at once: it reproduces JSON's last-wins semantics (so the key is counted
*once* in every coverage figure, matching what Xcode actually loads) **and** it preserves the
evidence of the conflict. Appending both entries would double-count the key in every percentage.

And the small mercies: `shouldTranslate: boolProp(node, 'shouldTranslate') ?? true`, because Xcode
omits the field when it's true; `state: stringProp(node, 'state') ?? 'translated'`, because a
missing state should assume good faith (an empty value is caught by the `empty` check anyway); empty
keys skipped rather than crashed on, because Xcode occasionally leaves one behind.

### `src/core/parse/strings.ts` — the legacy format (574 lines, and worth it)

This handles pre-String-Catalog projects: `en.lproj/Localizable.strings` and `.stringsdict`. Three
distinct problems solved here.

**1. Encoding.** Xcode wrote `.strings` as UTF-16 for years.

```ts
export function decodeTextFile(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le')
  // ... UTF-8 BOM ...

  // BOM-less UTF-16: ASCII text leaves a NUL in every other byte. Which half
  // holds the NULs tells us the endianness.
}
```

`Buffer` is Node's byte array (roughly `Data`). Reading everything as UTF-8 would turn half a
real-world repo into mojibake, so this reads bytes and decides. The BOM-less heuristic is the
interesting bit: sample 256 bytes, count NULs at even vs odd offsets, and if more than a quarter of
the sample is NUL it's UTF-16 — with the *side* the NULs fall on giving you the endianness.

**2. A hand-written `.strings` parser.** `"key" = "value";` with both comment styles, escaped
quotes, `\U0041` escapes, and the shorthand `"key";` form that means key-equals-value. Written as a
character-index scanner with small closures (`skipTrivia`, `readQuoted`, `readBare`) sharing the
cursor `i` — idiomatic TS where Swift would more likely reach for an `enum` state machine.

**3. A targeted `.stringsdict` plist reader.** Explicitly *not* a general plist implementation — it
understands `dict`, `array` and `string`, which is everything a stringsdict uses. It exists so
plural coverage works for projects that never migrated, and it maps onto the same `Localization`
shape as a String Catalog **so every downstream check applies unchanged**. That's the whole reason
the domain model is format-neutral, paying off.

The assembly step is where the real domain knowledge lives:

```ts
// `Localizable.strings` and `Localizable.stringsdict` are the SAME table -- the stringsdict
// supplies plural forms for keys the strings file declares -- so they merge rather than
// becoming two catalogs that each look half-empty.
```

```ts
// Only a redeclaration *within the same file* is a duplicate. A key that appears in both
// Localizable.strings and Localizable.stringsdict is the documented way to give a key
// plural forms, not a mistake.
const previous = byLanguage.get(info.language)
if (previous && previous.loc.file === loc.file) { /* record duplicate */ }
```

```ts
// Base.lproj is the development language by definition, so it is the source rather than
// a target that looks perpetually untranslated.
const sourceLanguage = options.sourceLanguage ??
  (languages.includes('Base') ? 'Base' : languages.includes('en') ? 'en' : (languages[0] ?? 'en'))
```

Each of those is a bug that a naive implementation ships and then gets an issue filed about.

### `src/core/parse/format-specifiers.ts` — the highest-value check

A missing translation shows the wrong language. A specifier mismatch between `"You have %lld items"`
and `"Sie haben %@ Artikel"` reads a 64-bit integer as an object pointer and **crashes at runtime**.
So this gets a real parser rather than a regex.

The grammar it implements:

```
%[argnum$][flags][width][.precision][length]conversion
%%                  literal percent
%[argnum$]#@name@   String Catalog substitution reference
%arg                the substituted argument, inside a substitution branch
```

The two String Catalog forms *must* be special-cased before flag scanning, because `#` is a valid C
flag and `@` a valid conversion — so `%1$#@files@` would otherwise scan as "object at position 1"
when it actually stands in for whatever the substitution declares (usually `lld`).

The comparison is where the design shows:

```ts
// Order may legitimately differ -- that is the entire point of positional specifiers --
// so this compares the index-to-type mapping, never the sequence.
const sourceMap = byPosition(parseFormatSpecifiers(source), options.sourceSubstitutions)
const targetMap = byPosition(parseFormatSpecifiers(target), options.targetSubstitutions)
```

German reorders arguments constantly; a translator writing `%2$@ hat %1$lld` is doing their job
correctly. Comparing sequences would fail every well-translated string. Comparing position to
type-class passes the reorder and still catches the type swap.

Three more calls worth internalising:

- **Type classes, not conversion characters.** `%d` and `%i` are both `integer`; comparing raw
  characters would flag a harmless substitution.
- **Width mismatch is a `warn`, never an `error`** — even when the user set `formatSpecifiers: error`.
  `%d` vs `%lld` is a real bug on 64-bit but usually prints garbage rather than trapping. The rule
  signals this with `forceWarn: true` rather than by setting a severity of its own, so severity
  policy stays in exactly one place (see the rules section below).
- **`unknown` on either side means silence.** An undeclared substitution is *an* argument of unknown
  type; inventing a mismatch you can't stand behind is how a linter earns a reputation for crying
  wolf. Same instinct as `known: false` in the CLDR table.

### `src/core/assess.ts` — read once, check many times

The idea: working out what a `(key, language)` pair actually *says* is the expensive part — it walks
the variation tree and the substitution table — and four checks plus the coverage figure all need
the answer.

> *Doing it once, here, is what keeps the rules cheap and, more importantly, keeps them agreeing with
> each other: the percentage and the issue list are computed from the same assessment, so they can
> never tell two different stories.*

That second clause is the real reason. A percentage computed separately from the issue list will
eventually disagree with it, and then the tool is lying in a way nobody can debug.

Notable calls:

**`needs_review` still counts as translated.**
```ts
const complete = winner === undefined || (winner.class !== 'empty' && winner.class !== 'new')
```
It has a real value in it, and this matches Xcode's own completion percentage. Diverging from the
number the developer sees in Xcode would make the tool feel broken even when it's right. It is still
reported — as a warning.

**Every branch the source defines must exist in the target.** A German string covering
`device.iphone` but not `device.ipad` is half-translated, and neither Xcode nor a naive "is there a
value?" check notices.

**`sourceReference` is careful about what "the source string" even is.** With literal keys the key
*is* the English text and there is no `en` localization block at all. Falling back to the key is
right there, and wrong for semantic keys like `payment_cvv_hint` — comparing specifiers against an
identifier would invent a mismatch for every translation that legitimately interpolates a value. So:

```ts
if (parseFormatSpecifiers(entry.key).length > 0) { /* trust the key as source */ }
return { leaves: [], substitutions: undefined, reliable: false, explicit: false }
```

Only trust the key when it actually looks like a format string, and otherwise return
`reliable: false` and let the checks stay quiet. Note the two separate flags: `reliable` ("can I
compare specifiers?") and `explicit` ("is there a real source block?"). Different checks need
different questions answered — `orphanKey` and `duplicateValue` need `explicit`, `formatSpecifier`
needs `reliable`. Collapsing them into one boolean would break one of the four callers.

**`referenceLeafFor` handles plural asymmetry.** Polish `few` has no English counterpart, but every
branch of a plural group carries the same arguments, so falling back to the source's `other` branch
is both safe and necessary to check expanded plurals at all.

### `src/core/coverage.ts` — the percentage, and why it's untrustworthy by default

The whole file exists because of one failure mode: **a percentage that says 100 when the catalog
isn't complete.** Two independent defences:

```ts
/** 0-100 to one decimal, rounded down. 100 only when nothing is outstanding. */
export function percentOf(translated: number, translatable: number): number {
  if (translatable === 0) return 100
  if (translated >= translatable) return 100
  return Math.floor((translated / translatable) * 1000) / 10
}
```

2999/3000 is 99.9666...%. Rounding to the nearest tenth gives **100.0** — a number no reader can
distinguish from a finished translation. So it floors.

```ts
// The gate never looks at the percentage at all.
const meets = entry.translatable === 0 || (entry.translated / entry.translatable) * 100 >= threshold
```

And the gate compares **counts**, not the displayed figure. So `threshold: 100` means *every string*,
not "a number that rounds to 100". Two defences for one bug, because the display and the gate are
read by different people for different reasons.

The last subtlety: a required language that is only ever a *source* language has nothing to translate
into, so gating it would fail the run at 0% forever. It's skipped. But a required language that
appears in *no* catalog is a config mistake and is reported.

### `src/core/rules/` — seven checks, one shape

```ts
export interface Rule {
  name: string
  classes: readonly IssueClass[]           // every class this rule can emit
  run: (context: RuleContext) => void
}
```

**Rules never decide whether they run.** The runner in `analyze.ts` skips any rule whose classes are
all `off`, and drops individual issues whose class is `off`:

```ts
const rules = (options.rules ?? ALL_RULES).filter((rule) =>
  rule.classes.some((issueClass) => config.severity[issueClass] !== 'off'))

const report = (pending: PendingIssue): void => {
  const configured = config.severity[pending.class]
  if (configured === 'off') return
  const { forceWarn, ...rest } = pending      // destructure out the flag, keep the rest
  issues.push({ ...rest, catalog: catalog.path, severity: forceWarn ? 'warn' : configured })
}
```

That keeps "is this check enabled?" in exactly one place instead of seven, and it's why
`PendingIssue` is `Omit<Issue, 'severity' | 'catalog'>` — the rule literally *cannot* set its own
severity or catalog, because those fields don't exist on the type it returns. The type system
enforces the architecture. (`Omit<T, K>` is a built-in mapped type: `T` minus those keys.)

The seven rules, and the judgement in each:

| Rule | Default | The call |
|---|---|---|
| `state` | error/warn | Pure translation of the assessment into messages; all the work already happened. `extractionState: stale` is reported **once per key, not per language** — fanning it across 30 locales would bury everything else. |
| `format-specifiers` | error | The crash-causer. Skips entirely when `!source.reliable`. |
| `plural-coverage` | warn | Runs against the **source language too** — an English plural that forgot `one` is as broken as a Polish one that forgot `few`. Silent on locales with no CLDR data, because a guessed complaint is worse than silence. |
| `duplicate-keys` | **error** | One of the two definitions is *already* silently discarded by Xcode. Usually a bad merge, and the string that lost is normally the one somebody just translated. |
| `duplicate-values` | warn | Two keys, same source text — paid for and reviewed twice in every language. Only a **warn**, because "Order" the noun and "Order" the verb genuinely need two keys and only the author can tell. |
| `orphan-keys` | warn | Needs different evidence per format: legacy tables declare every key in every `.lproj`, so absence is unambiguous; String Catalogs routinely have no source block, so it only fires for keys that clearly aren't source text themselves. |
| `identical-to-source` | **off** | *"Cancel", "OK", "Email", "Wi-Fi" and every product name are legitimately identical in a dozen languages, and a check that fires on those is a check people switch off within a day.* |

That last row is the most important product decision in the repo. A check that is right 60% of the
time and on by default doesn't cost you 40% precision — it costs you the entire tool, because people
disable the whole action rather than tune one rule.

### `src/core/revision.ts` — reading the base branch without touching the working tree

```ts
export interface RevisionFiles {
  list: () => string[]
  read: (path: string) => Buffer | undefined
  label: string
}
```

An interface with two function-typed properties. Two implementations — `workingTreeFiles` (glob plus
`readFileSync`) and `gitRevisionFiles` (`git ls-tree` plus `git show`) — and `scan()` is written once
against the interface. In Swift this would be a `protocol` with two conforming types; structurally,
in TS, it's just an object literal with the right shape. Same benefit: the base branch is read
without ever checking it out, so the working tree is never disturbed.

```ts
execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', revision], { cwd, encoding: 'utf8' })
```

`execFileSync`, not `exec`: it takes an **argv array and spawns no shell**, so a branch name
containing `;` or a command substitution is data, not code. This is the equivalent of using
parameterised SQL. The `-z` flag means NUL-separated output, which is the only safe way to read a
list of paths that may contain newlines.

The merge-base decision, quoted because the reasoning is the whole point:

> *Prefers the merge base over the base tip: comparing against the tip attributes everything that
> landed on the base branch since you branched to your change, in both directions, which is exactly
> the unfair complaint this comparison exists to avoid.*

And the graceful degradation: shallow clones often have the branch tip but not enough history for a
merge base, so it falls back to the tip *with a notice explaining `fetch-depth: 0`* rather than
failing. But note that `BaseResolution` returns `{ revision?, problem? }` instead of throwing —

> *Returned rather than thrown because whether it is fatal depends on the mode, and that is the
> caller's call to make, not this function's.*

That's a real API-design principle worth stealing: a function that discovers a problem shouldn't
decide how serious it is.

### `src/core/compare.ts` — "did I do this?"

Small file, big idea. Both sides are parsed into issue sets and the **sets** are compared:

> *The comparison is semantic, never textual. Xcode rewrites large regions of `.xcstrings` JSON on
> every build, so a text diff of these files is almost pure noise.*

The identity function is where the care is. The five state classes share **one** identity per
`(catalog, key, language)`, because they are mutually exclusive states of the same pair — a
translation going from `new` to `empty` is still the same untranslated string and must not register
as a fresh regression. Every other class gets its own identity, because a format break in an
already-`needs_review` string genuinely *is* new.

And `unifiedLanguages` fixes a bug you would absolutely ship without thinking about it:

> *Both sides have to be assessed against the same set, or adding a language makes every one of its
> keys look like a fresh regression and removing one makes the whole locale look fixed.*

### `src/report/` — one model, three surfaces

| Surface | Constraint | Consequence |
|---|---|---|
| PR comment | 65536 chars; needs a writable token | Two-tier layout, truncation that preserves the marker; fork PRs degrade |
| Job summary | 1 MB; always works, no token | Carries the **complete** picture — 200 rows per section |
| Annotations | **10 per level per step** | A planner that sorts errors first, so the surviving 10 are the right 10 |

`ReportInput` in [`model.ts`](src/report/model.ts) is computed once by `buildReport` and read by all
three. The comment about it is the design:

> *"Does it block?" and "was it already there?" are different questions, and every field below
> answers exactly one of them. An earlier cut folded them together — warnings meant "non-blocking
> and not pre-existing" — and the counts built on it were quietly wrong: a run with six warnings the
> base also had reported zero warnings.*

So `blocking`/`nonBlocking` is one partition, `preExisting`/`newIssues` is another, they overlap
freely, and the *display* buckets (`carriedIssues`, `warningIssues`) are derived at render time. Two
orthogonal facts, kept orthogonal in the data, combined only at the last moment. That's a general
lesson about conflating booleans that happen to correlate.

The sticky comment mechanism:
```ts
export const COMMENT_MARKER = '<!-- xcstrings-lint -->'
```
An HTML comment (invisible in rendered Markdown) is written into the body; on the next run the code
lists PR comments, finds the one carrying the marker, and PATCHes it. So a branch with twenty pushes
has one comment, not twenty. Two details: `truncate()` re-appends the marker when it trims, because
a truncated body that dropped it would orphan the comment and post a fresh one on every push; and
the search prefers a comment written by a **Bot**, so a human quoting the marker can't hijack it.

`groupLanguagesByIssues` is a small but real UX decision: a project shipping eight locales usually
breaks all of them the same way, so it collapses identical rows into
`de, es, fr, it, ja, ko, pt-BR, zh-Hans — 3 missing`. The per-language split only earns its space
when it actually differs. And percentages are deliberately absent from the comment: *"2 missing" is
something a reviewer can act on, "98.8%" is not.*

---

## 6. The dependencies, and why each one earns its place

Seven runtime dependencies. Each one is bundle size on every action run, so each is a decision.

| Package | Job | Why not do it yourself |
|---|---|---|
| `@actions/core` | inputs, outputs, annotations, job summary | The workflow-command protocol is stdout magic strings. Getting the escaping wrong silently breaks annotations. |
| `@actions/github` | authenticated Octokit plus the event payload | Pagination, rate limits, auth. Not worth reimplementing. |
| `fast-glob` | `**/*.xcstrings` on disk | Correct glob semantics plus not descending into `node_modules` is a lot of subtle code. |
| `picomatch` | glob **matching** without a filesystem | Needed for `git ls-tree` output, which is a list of strings with no disk behind it. Same syntax as fast-glob, so users learn one thing. |
| `jsonc-parser` | JSON to a syntax tree with byte offsets | The whole reason annotations have real line numbers. |
| `yaml` | parse the config file | With a typed `YAMLParseError.linePos`, so a bad config gets a line number. |
| `zod` | validate the config at runtime | TS types are erased; something has to actually check. |

Deliberately **not** a dependency: **CLDR plural data**. `cldr-plurals.ts` is a hand-maintained
~60-line table instead.

> *It is ~60 lines of data that changes roughly never, and a CLDR dependency would be megabytes in
> the ncc bundle for this one lookup.*

The table has a `LOCALE_OVERRIDES` map that is **currently empty**, with a comment explaining that
every region variant Xcode emits (`pt-BR`, `zh-Hans`, `es-419`, `fr-CA`) shares its base language's
categories — *"but the hook is here so a future divergence is a one-line change."* An empty
extension point with a written rationale is much better than either no extension point or a
speculative implementation.

---

## 7. Testing

**354 tests across 13 files, running in about 2 seconds.** Run them:

```bash
npm test
```

Vitest is XCTest with a nicer watch mode:

| Vitest | XCTest / Swift Testing |
|---|---|
| `describe('...', () => {...})` | a test class / `@Suite` |
| `it('...', () => {...})` | `func testX()` / `@Test` |
| `expect(x).toBe(y)` | `XCTAssertEqual` / `#expect` |
| `expect(x).toEqual(y)` | deep structural equality |
| `expect(x).toMatchSnapshot()` | no direct equivalent |

`vitest.config.ts` is three lines: which files are tests, `environment: 'node'` (no fake browser),
and a 20-second timeout.

### Test-name-as-specification

The test names are written as assertions about behaviour, not as labels for code:

```ts
describe('the percentage', () => {
  it('never rounds up to 100', () => {
    // Regression: 2999/3000 is 99.9666...%, and rounding to the nearest tenth gave
    // 100.0 -- a figure indistinguishable from a finished translation.
    expect(percentOf(2999, 3000)).toBe(99.9)
  })
})

describe('the threshold gate', () => {
  it('compares counts, not the displayed percentage', () => { /* ... */ })
})

describe('the whole repository is the scope', () => {
  it('checks every catalog it finds, not a diff', () => { /* ... */ })
})
```

You can read the test names and learn the product. And the regression tests carry the *original bug*
in a comment, so nobody "simplifies" the fix away in six months.

### Test infrastructure worth copying

**Builders, not fixtures, for the common case.** Most tests construct catalogs inline:
```ts
const catalog = (strings: Record<string, unknown>): string =>
  JSON.stringify({ sourceLanguage: 'en', strings, version: '1.0' })
const unit = (state: string, value: string) => ({ stringUnit: { state, value } })
```
so a test reads as "this catalog, this expectation" with no jumping to a fixture file.

**Real files on disk when the thing under test reads disk.**
```ts
function project(files: Record<string, string>, body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'xcstrings-lint-'))
  try { /* write files */ body(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
```
A temp directory, a callback, and `finally` cleanup. No mocking of `fs`. The glob behaviour, the
encoding detection and the path handling are the things most likely to be wrong, and mocking the
filesystem would mock away exactly those.

**Byte-sensitive fixtures, protected in `.gitattributes`.**
```
__tests__/fixtures/** -text
```
Because the tests cover UTF-16 and BOM handling — git normalising line endings would destroy the
very thing under test. Note the parallel entry for `dist/`:
```
dist/** -diff linguist-generated=true
```
which keeps the 2 MB generated bundle out of diffs and out of GitHub's language statistics, while
still committing it.

**Snapshots for rendered Markdown.** `__snapshots__/report.test.ts.snap` holds the expected report
output verbatim. Asserting on 40 lines of Markdown with individual `expect`s is unmaintainable; a
snapshot makes any layout change show up as a reviewable diff. Update with `npx vitest -u` — and
*read the diff*, because a snapshot you update without reading is a test you deleted.

**Injection seams, not mocking frameworks.** Notice these:
```ts
export type InputReader = (name: string) => string           // action/inputs.ts
export function readInputs(get: InputReader): ActionInputs    // <- never imports @actions/core

lint({ /* ... */ config?: ResolvedConfig })                   // "Injected for tests"
analyze(catalogs, config, { rules?: readonly Rule[] })        // "injected by tests"
assembleLegacyCatalogs(files, { onError?: (e) => void })
```
Plain function parameters. There is no mocking library anywhere in the repo. `readInputs` is pure, so
every input-validation rule is tested without a runner; `lint()` never touches `@actions/core`, so
the entire engine is testable as a function call. **This is a consequence of the layering, not a
substitute for it** — you can only inject like this if the dependency direction is already right.

---

## 8. The GitHub Actions layer

### `action.yml` — the public interface

The manifest GitHub reads. It declares `inputs`, `outputs`, and:

```yaml
runs:
  using: 'node20'
  main: 'dist/index.js'
```

Inputs are **always strings** (or absent). There is no typed input in Actions — `threshold: 100` and
`comment: true` both arrive as text, which is why `readInputs` exists and why it validates rather
than trusts. The `outputs` here are declaration-only; the values are set at runtime by
`core.setOutput()`.

### Why `dist/` is committed

**GitHub Actions does not build JavaScript actions.** When a workflow says
`uses: thatswiftguy/xcstrings-lint@main`, GitHub clones the repo and runs `node dist/index.js`
immediately. No `npm install`, no build step.

So `@vercel/ncc` bundles `src/main.ts` plus every runtime dependency into **one 2.2 MB
`dist/index.js`**, and that file is committed. Conceptually it's static linking: ship one artifact
with no install step at the far end.

This creates a failure mode with no analogue in iOS: **`dist/` can drift from `src/`**, and then the
action silently runs yesterday's code. Two guards, both in CI:

```yaml
# .github/workflows/test.yml -- job: "dist is current"
- run: npm run build
- run: |
    if ! git diff --quiet --exit-code dist/; then
      echo "::error::dist/ is out of date. Run 'npm run build' and commit the result."
      exit 1
    fi
```

and the same check again in `release.yml` ("Refuse to release a stale dist"). A
build-output-in-git convention needs a mechanical guard, or it will be wrong.

**Practical consequence for you: after changing anything in `src/`, run `npm run build` and commit
`dist/` in the same commit.**

### `.github/workflows/self-check.yml` — the action running on itself

This is the most interesting file in the repo from a testing-philosophy standpoint. Four jobs, each
running the real bundle in a real runner against the test fixtures:

1. **clean project passes** — asserts `passed=true`, `issue-count=0`, and `files-scanned > 0`
2. **broken project fails** — asserts `passed=false`, warnings found, coverage output mentions `de`,
   and that the report text actually names each kind of problem
3. **an empty scan is an error, not a pass** — see below
4. **ratchet reports the backlog without blocking on it**

Job 3 is the one to take away:

```
# A linter whose globs match no files must say so. Reporting "fully translated" for a
# project it never read is the one failure mode that looks exactly like success.
```

```ts
// lint.ts
if (head.matched.length === 0) {
  throw new ConfigError(`no catalog files matched. Searched for:\n` + /* ... */)
}
```

A wrong `paths` entry, or a missing `actions/checkout` step, turns the check permanently green while
reading nothing. **Exit 2, naming the patterns it searched.** If you build one linting tool in your
career, build this in.

Unit tests can't catch a broken bundle, a bad `action.yml`, or a runner-environment assumption.
These jobs exercise the shipped artifact end to end — and they double as a live, always-current
usage example, which is why the repo's own `.xcstrings-lint.yml` points at the clean fixture rather
than being a dead file.

### `.github/workflows/release.yml`

Fires on a `v*.*.*` tag: typecheck, test, refuse a stale `dist`, **assert the tag matches the
`package.json` version**, force-move the major tag (`v2`) so consumers pinning `@v2` get the new
release without editing their workflow, then create the GitHub release *if it doesn't already exist*
(idempotent, because drafting a release in the UI creates the tag, which fires this same workflow).

That last parenthetical is the kind of thing you only learn by having a release workflow paint
itself red once.

### Exit codes — the actual contract

| Code | Meaning | Where |
|---|---|---|
| `0` | passed, or issues found with `fail: false` | `report.passed === true` |
| `1` | blocking issues found | `core.setFailed(summary)` |
| `2` | misconfiguration, an unreadable file, or globs that matched nothing | `misconfigured()` |

```ts
function misconfigured(message: string): void {
  core.setFailed(message)
  process.exitCode = 2   // setFailed sets 1; 2 is reserved for "this tool is misconfigured"
}
```

Note `process.exitCode = 2` rather than `process.exit(2)`. Setting the property lets the process
finish flushing stdout and any pending async work and *then* exit; `process.exit()` terminates
immediately and can truncate output — which, for a tool whose product is its output, would mean
losing the explanation of why it failed.

Separating "your translations are incomplete" (1) from "this tool is misconfigured" (2) is what lets
a team wire up `continue-on-error` for the former while still being alerted to the latter.

---

## 9. The design principles this codebase actually follows

Extracted from the code, in rough order of how much they would improve an average codebase:

1. **A tool that finds nothing must prove it looked.** The empty-scan-is-an-error rule. The one
   failure mode that looks exactly like success.
2. **Compute the verdict once.** `buildReport` decides `passed`; `exitCodeFor` maps it; `main.ts`
   *asks* rather than re-deriving. The comment, the summary and the exit code cannot disagree.
3. **Read once, check many times.** `assess.ts` exists so the percentage and the issue list are
   derived from the same reading and can't tell two different stories.
4. **Keep orthogonal facts orthogonal in the data.** "Does it block?" and "was it already there?"
   are separate partitions; combine them only at render time. The bug that motivated this is in the
   comment.
5. **Never round in the direction that flatters you.** Floor the percentage; gate on counts.
6. **A check that cries wolf gets the whole tool switched off.** `identicalToSource` off by default;
   silence on unknown CLDR locales; silence when the source string is unreliable.
7. **Error messages name the file, the option, and the fix.** Not just the rejection. A bad config
   gets a pointed error, never a stack trace.
8. **Push decisions to the layer that owns them.** `resolveBaseRevision` returns a `problem` string
   instead of throwing, because only the caller knows whether a missing base is fatal.
9. **Make the architecture impossible to violate.** `PendingIssue = Omit<Issue, 'severity' | 'catalog'>`
   means a rule *cannot* set its own severity.
10. **One source of truth for lists.** `as const` array, then derive the union type. Adding an issue
    class makes the compiler enumerate every place that needs updating.
11. **Guard your conventions mechanically.** `dist/` is committed, so CI diffs it on every PR.
12. **Comment the *why*, never the *what*.** Nearly every comment in this repo is a decision, a
    rejected alternative, or a bug that motivated the code. Go read them — that's the real
    documentation, and it's the habit most worth importing into your Swift code.

---

## 10. Working on it day to day

```bash
nvm use
```
Switch to the Node version in `.nvmrc` (24.4.1).

```bash
npm ci
```
Install exactly what `package-lock.json` says. CI-safe; prefer it over `npm install`, which can
update the lockfile.

```bash
npm run typecheck
```
`tsc --noEmit` — the compiler, with no output files.

```bash
npm test
```
`vitest run` — one pass, 354 tests, about 2 seconds.

```bash
npm run test:watch
```
Re-runs affected tests on save.

```bash
npm run build
```
`ncc` to `dist/index.js`. Run this before committing `src/` changes.

```bash
npm run all
```
typecheck, test, build — what CI runs.

To try the linter against real catalogs locally, drive `lint()` directly from a scratch test rather
than running `dist/index.js`: `main.ts` reads Actions environment variables, whereas `lint()` takes
a plain `cwd` and needs no runner. That is precisely why the two were separated.

### The workflow for a change

1. Change `src/`.
2. `npm run typecheck` — the strict flags catch most mistakes here.
3. Add or update a test. Name it as a claim about behaviour.
4. `npm test`. If a snapshot changed, `npx vitest -u` **and read the diff**.
5. `npm run build`, and commit `dist/` alongside `src/`.
6. Adding a new check? Three touches: a file in `src/core/rules/`, an entry in `ALL_RULES`, and a
   severity default in `config.ts`. The compiler then tells you about `CLASS_LABELS`,
   `CLASS_COLUMNS` and `TITLES`, because they are all `Record<IssueClass, string>`.

---

## 11. Cheat sheet

### Syntax you'll hit immediately

| TypeScript | Meaning | Swift |
|---|---|---|
| `const` / `let` | immutable / mutable binding | `let` / `var` |
| `a ?? b` | if `a` is null or undefined, use `b` | `a ?? b` |
| `a?.b` | optional chain | `a?.b` |
| `a ??= b` | assign only if nullish | — |
| `x as T` | unchecked assertion, no runtime check | closer to `unsafeBitCast` than to `as?` |
| `x!` | "not null, trust me" (silences the compiler, never crashes) | `x!` |
| `{...a, b: 1}` | shallow copy plus override | — |
| `[...a, ...b]` | array concat / copy | `a + b` |
| `const {a, ...rest} = obj` | destructure, collect the remainder | — |
| `for (const x of arr)` | iterate values | `for x in arr` |
| `for (const [k, v] of map)` | iterate a Map | `for (k, v) in dict` |
| `Object.entries(o)` | `Record` to `[key, value][]` | — |
| `Object.fromEntries(p)` | the inverse | `Dictionary(uniqueKeysWithValues:)` |
| `map` `filter` `reduce` `find` `some` `every` `flatMap` | as in Swift | `map` `filter` `reduce` `first(where:)` `contains` `allSatisfy` `flatMap` |
| `arr.sort(cmp)` | **mutates in place** — hence `[...issues].sort(...)` | `sorted(by:)` does not |
| `a.localeCompare(b)` | string ordering, returns -1 / 0 / 1 | `a < b` |
| backtick template | interpolation with `${expr}` | `"text \(expr)"` |
| `type X = A \| B` | union | roughly an enum with cases |
| `interface X { ... }` | object shape | `struct` / `protocol` |
| `readonly T[]` | immutable array type | a `let` array |
| `X as const` | freeze to literal types | — |
| `X satisfies T` | check without widening | — |
| `Omit<T,K>` `Pick<T,K>` `Partial<T>` `Record<K,V>` | built-in type transforms | — |
| `(typeof ARR)[number]` | element type of a tuple | `CaseIterable`, backwards |
| `import type { X }` | type-only import, erased at compile time | — |
| `void main()` | deliberately not awaiting a promise | — |

### Gotchas that will actually bite you

- **`.js` in every relative import**, even though the file on disk is `.ts`. Not optional.
- **`===`, never `==`.** `==` does type coercion (`'' == 0` is `true`).
- **`array[i]` is `T | undefined`** in this repo (`noUncheckedIndexedAccess`), and never traps at
  runtime the way a Swift subscript does.
- **`sort()` mutates.** Copy first: `[...xs].sort(...)`.
- **`Set` and `Map` compare objects by identity**, never by content. Section 3 explains where this
  repo depends on that.
- **`0`, `''`, `NaN` and `false` are all falsy.** `if (count)` is a bug when `0` is meaningful.
- **No `throws` in signatures.** Any function can throw anything. Catch centrally.
- **`catch (e)` gives you `unknown`.** Narrow it yourself.
- **Types are erased.** Anything crossing a trust boundary needs a runtime check — that's zod's job.
- **`as` is not a cast.** It generates no code and does no checking.

### Where to look for what

| Question | File |
|---|---|
| What shapes does everything speak? | `src/core/types.ts` |
| What decides pass or fail? | `src/lint.ts` (`buildReport`, `exitCodeFor`) |
| What are the config options and defaults? | `src/core/config.ts` |
| How is `.xcstrings` read? | `src/core/parse/xcstrings.ts` |
| How is legacy `.strings` read? | `src/core/parse/strings.ts` |
| What does a `(key, language)` pair actually say? | `src/core/assess.ts` |
| How is the percentage computed and gated? | `src/core/coverage.ts` |
| What are the checks? | `src/core/rules/` |
| How is "new vs pre-existing" decided? | `src/core/compare.ts` |
| How is the Markdown built? | `src/report/model.ts`, `comment.ts`, `summary.ts` |
| Where does GitHub Actions enter? | `src/main.ts`, `src/action/`, `action.yml` |
| What is the public contract? | `action.yml`, `README.md` |

---

*One closing note. The most transferable thing in this repository is not the TypeScript — it's the
comments. Nearly every one records a decision, a rejected alternative, or the bug that motivated the
code, and almost none of them restate what the line does. Read `coverage.ts`, `compare.ts` and
`identical-to-source.ts` for that alone, then go write your Swift that way.*

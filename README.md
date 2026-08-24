# xcstrings-lint

**Catch missing iOS translations before they merge.**

[![Test](https://github.com/thatswiftguy/xcstrings-lint/actions/workflows/test.yml/badge.svg)](https://github.com/thatswiftguy/xcstrings-lint/actions/workflows/test.yml)
[![Self-check](https://github.com/thatswiftguy/xcstrings-lint/actions/workflows/self-check.yml/badge.svg)](https://github.com/thatswiftguy/xcstrings-lint/actions/workflows/self-check.yml)

Xcode shows a completion percentage in the String Catalog editor and never fails the build. So a
developer adds a string, translates it into one or two languages, and the rest ship as raw key IDs
in the UI. The pull request is the one place where that is still cheap to fix — and the only place
where one person's miss is visible to someone else.

---

## What your reviewers see

> ### 🌍 xcstrings-lint — **failed**
>
> **5 new issues** across 2 languages vs `main`.
>
> | Language | Before | After | Δ | New issues |
> |---|---|---|---|---|
> | `de` | 100% | 100% | — | 0 |
> | `fr` | 100% | 98.8% | 🔻 1.2% | **2** |
> | `ja` | 100% | 98.2% | 🔻 1.8% | **3** |
>
> <details open><summary>New issues (5)</summary>
>
> | Key | fr | ja |
> |---|---|---|
> | `payment_save_card_title` | ✓ | ✕ missing |
> | `payment_save_card_subtitle` | ✕ missing | ✕ missing |
> | `payment_cvv_hint` | ⚠ empty | ✕ missing |
>
> </details>
>
> <sub>Mode: `ratchet`</sub>

One sticky comment, updated in place on every push. Plus inline annotations on the exact lines, and
a full job summary that works even on fork pull requests.

---

## Quick start

```yaml
name: Localization
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - uses: thatswiftguy/xcstrings-lint@v1
```

That is the whole thing. No config file, no macOS runner, no Xcode.

`fetch-depth: 0` matters: the default ratchet mode compares your branch against the base, and that
needs the base branch in the clone. Without it you get a clear error telling you so, not a git
stack trace.

---

## What it catches

Five translation states, kept separate because they have different urgency and different fixes.
Collapsing them into one "missing" bucket is what gets a linter muted.

| Class | Meaning | Default |
|---|---|---|
| `missing` | The key has no entry in that language at all | **fail** |
| `empty` | An entry exists but `value` is `""` | **fail** |
| `new` | `state: "new"` — extracted by Xcode, never touched | **fail** |
| `needsReview` | `state: "needs_review"` | warn |
| `stale` | `extractionState: "stale"` — Xcode can no longer find the key in source | warn |

Plus two structural checks that are arguably worth more than the missing-key check:

**Format specifier mismatch.** If the source is `"You have %lld items"` and the German is
`"Sie haben %@ Artikel"`, that reads a 64-bit integer as an object pointer. It is a runtime crash,
not a cosmetic bug. The check compares the index-to-type mapping, so a legitimate reordering with
positional specifiers (`%1$@ sent %2$lld files` → `%2$lld Dateien von %1$@`) passes cleanly, while a
type swap at any position fails with specifics:

```
expected %lld at position 1, found %@
```

A width-only difference (`%lld` vs `%d`) is a real bug but not a crash, so it always warns rather
than failing, even when `formatSpecifiers: error`.

**Plural category coverage.** Polish needs `one`/`few`/`many`/`other`. Japanese needs only `other`.
Arabic needs all six. A translation with just `one` and `other` is grammatically wrong in Polish,
and Xcode's editor shows exactly these categories per language. Ships as a small static CLDR table —
no dependency, no network. Locales the table does not know are never reported against, because a
guessed complaint is worse than silence.

Both structural checks also look inside String Catalog `substitutions` (the `%#@name@` form Xcode
emits when a string has more than one independently pluralising argument) and inside legacy
`.stringsdict` files.

---

## Ratchet mode, and why it is the default

An absolute gate fails on the very first pull request of any real project and gets switched off
within a week. Ratchet mode only reports what **your branch** introduced:

> you added 3 strings and translated 0 of them

instead of

> your project is 87% translated

which is not the author's fault and not their pull request's problem.

The gate is the set of newly-introduced `(catalog, key, language)` problems — not a coverage
percentage. That distinction matters more than it looks. Add ten fully-translated strings plus one
untranslated one, and your overall percentage goes **up** while you ship an untranslated string; a
percentage gate waves that through. The set difference catches it.

Two more details that keep it fair:

- The comparison is against the **merge base**, not the base tip. Otherwise everything that landed
  on `main` since you branched gets attributed to you, in both directions.
- The comparison is **semantic**, never textual. Xcode rewrites large regions of `.xcstrings` JSON
  on every build, so a text diff of these files is almost pure noise. Both sides are parsed into
  issue sets and the sets are compared.

Coverage percentages still appear in the report. They are information, not the gate.

---

## Rolling it out

Start non-blocking, so the team sees the reports before anything can stop a merge:

```yaml
      - uses: thatswiftguy/xcstrings-lint@v1
        continue-on-error: true
```

Leave it there for a sprint. The comment and annotations show up on every pull request; nothing is
blocked. Once the team is at parity and the reports are boring, delete the `continue-on-error` line
and turn on branch protection.

### Branch protection

The action can only pass or fail. Making that block a merge is a repository setting:

1. **Settings → Branches → Add branch ruleset** (or edit your existing rule for `main`)
2. Enable **Require status checks to pass**
3. Search for and tick **`Localization / check`**

The check name is `<workflow name> / <job name>` from your workflow file. With the quick-start YAML
above that is `Localization / check`. The check has to have run at least once on a pull request
before GitHub will offer it in that list.

---

## Configuration

Everything beyond the handful of action inputs lives in `.xcstrings-lint.yml` at the repository
root. Every field is optional; the file itself is optional.

```yaml
paths:
  - '**/*.xcstrings'
  - '**/*.strings'

sourceLanguage: en
required: [de, fr, ja]

failOn: [missing, empty, new]
warnOn: [needsReview, stale]

ignore:
  keys:
    - 'app_name'
    - 'OK'
  patterns:
    - 'debug_*'
  files:
    - '**/Tests/**'

formatSpecifiers: error
pluralCoverage: warn
```

| Option | Type | Default | Notes |
|---|---|---|---|
| `paths` | globs | `**/*.xcstrings`, `**/*.strings`, `**/*.stringsdict` | Which catalogs to read |
| `sourceLanguage` | string | each catalog's own `sourceLanguage` | Override only if the catalog is wrong |
| `required` | list | every language found in any catalog | Languages to gate on |
| `failOn` | list | `[missing, empty, new]` | Classes that fail the run |
| `warnOn` | list | `[needsReview, stale]` | Classes that report but never fail |
| `ignore.keys` | list | — | Exact key names to skip entirely |
| `ignore.patterns` | globs | — | Key globs to skip, e.g. `debug_*` |
| `ignore.files` | globs | — | File globs to skip |
| `formatSpecifiers` | `error` \| `warn` \| `off` | `error` | The crash-class check |
| `pluralCoverage` | `error` \| `warn` \| `off` | `warn` | The CLDR category check |

A malformed config file gets a pointed error, not a stack trace:

```
.xcstrings-lint.yml: invalid configuration
  - pluralCoverage: Invalid enum value. Expected 'error' | 'warn' | 'off', received 'loud'
```

Three behaviours worth knowing:

- **An explicit list replaces the default, it does not extend it.** `failOn: [missing]` means
  *only* `missing` fails; `empty` and `new` fall through to `warnOn`, or off if they are in neither.
  Listing a class in both `failOn` and `warnOn` is a config error rather than a silent precedence rule.
- **`node_modules`, `Pods`, `Carthage`, `.build` and `DerivedData` are always skipped**, on top of
  whatever you put in `ignore.files`.
- **`needs_review` still counts as translated** in the coverage percentage — it has a real value in
  it, and that matches what Xcode's own completion percentage does. It is reported separately as a
  warning.

### Action inputs

| Input | Default | Description |
|---|---|---|
| `config` | `.xcstrings-lint.yml` | Path to the config file |
| `mode` | `ratchet` | `ratchet` or `absolute` |
| `threshold` | `100` | Minimum coverage percent per language (absolute mode only) |
| `comment` | `true` | Post a sticky pull request comment |
| `annotations` | `true` | Emit inline file annotations |
| `fail` | `true` | Exit non-zero when issues are found |
| `github-token` | `${{ github.token }}` | Token used to post the comment |

### Action outputs

| Output | Example |
|---|---|
| `passed` | `false` |
| `coverage` | `{"de":100,"fr":98.8,"ja":98.2}` |
| `issue-count` | `5` |
| `report` | The rendered Markdown report |

---

## Recipes

### Strict gate on release branches

Ratchet on every pull request, but demand full coverage before a release goes out:

```yaml
name: Localization
on:
  pull_request:
  push:
    branches: ['release/**']

permissions:
  contents: read
  pull-requests: write

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - uses: thatswiftguy/xcstrings-lint@v1
        with:
          mode: ${{ startsWith(github.ref, 'refs/heads/release/') && 'absolute' || 'ratchet' }}
          threshold: 100
```

### Weekly coverage report

A standing number for the team, that never blocks anyone:

```yaml
name: Localization coverage
on:
  schedule: [{ cron: '0 9 * * MON' }]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: thatswiftguy/xcstrings-lint@v1
        with:
          mode: absolute
          threshold: 100
          fail: false
          comment: false
```

The result lands in the job summary. Scheduled runs have no base branch, which is why this one uses
`mode: absolute`.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Passed, or issues found with `fail: false` |
| `1` | Blocking issues found |
| `2` | Misconfiguration, unreadable file, or missing base ref |

`1` and `2` are deliberately different. "Your translations are incomplete" and "this tool is set up
wrong" need different reactions, and a file we could not parse is never quietly reported as 100%
covered. A `2` always comes with an annotation naming the file or option at fault.

---

## Fork pull requests

On a `pull_request` from a fork, `GITHUB_TOKEN` is read-only and the comment API returns 403. The
action logs a one-line notice and carries on — the annotations and the job summary still work, and
the job does **not** fail over it.

It deliberately does not tell you to switch to `pull_request_target`. That event runs with a
writable token and access to secrets in the context of the base repository, and using it to check
out a fork's code is a well-known way to hand your secrets to a stranger.

---

## How it works

`.xcstrings` is plain JSON and `.strings` is a trivial text format, so everything is parsed
directly from disk. There is no `xcodebuild`, no `xcrun`, no Swift toolchain and no macOS
dependency — it runs on `ubuntu-latest`, which is roughly ten times cheaper and considerably faster
than a macOS runner.

The JSON is parsed with a location-preserving parser rather than `JSON.parse`, so every key and
every per-language block carries a real line number. Annotations that all point at line 1 are
useless.

Legacy projects are handled too: `.strings` tables are grouped by `.lproj` directory, with UTF-16
detection for the files older Xcode versions wrote, and `.stringsdict` plural structures are read
into the same model so every check applies to them unchanged.

---

## Not in v1

Deliberately out of scope, to keep the core solid: a standalone CLI or npm package, machine
translation and auto-fix pull requests, XLIFF / `.xcloc`, Android `strings.xml`, TMS integrations
(Lokalise, Crowdin, Phrase), a web dashboard, and Checks API batching.

This ships as a GitHub Action only. The engine underneath has no dependency on the Actions runtime,
so a CLI would be a small addition if it is ever wanted -- but there isn't one today.

---

## License

MIT

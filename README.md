# xcstrings-lint

**Catch missing, duplicate and broken iOS translations before they merge.**

[![Test](https://github.com/thatswiftguy/xcstrings-lint/actions/workflows/test.yml/badge.svg)](https://github.com/thatswiftguy/xcstrings-lint/actions/workflows/test.yml)
[![Self-check](https://github.com/thatswiftguy/xcstrings-lint/actions/workflows/self-check.yml/badge.svg)](https://github.com/thatswiftguy/xcstrings-lint/actions/workflows/self-check.yml)

Xcode shows a completion percentage in the String Catalog editor and never fails the build. A
developer adds a string, translates it into one or two languages, and the rest ship as raw key IDs.
Somebody else pastes a key that already exists, and Xcode silently keeps whichever copy came last.
The pull request is the last place that is still cheap to fix.

Every run reads **every catalog in the repository** and reports the complete picture: what is
missing, in which language, plus the duplicates, orphans and format-specifier crashes that no
percentage will ever show you.

Runs on `ubuntu-latest`. No Xcode, no macOS runner, no Apple toolchain — `.xcstrings` is just JSON.

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
      - uses: thatswiftguy/xcstrings-lint@v2
```

That's the whole thing — no config file needed, and no `fetch-depth` to get right.

---

## What it catches

| Check | Default | What it means |
|---|---|---|
| `missing` | **fail** | No entry for that key in that language |
| `empty` | **fail** | Entry exists, value is `""` |
| `new` | **fail** | Extracted by Xcode, never translated |
| `duplicateKeys` | **fail** | Same key declared twice in one file — one copy is silently discarded |
| `formatSpecifiers` | **fail** | `%lld` vs `%@` — a runtime crash, not a cosmetic slip |
| `needsReview` | warn | Marked `needs_review` |
| `stale` | warn | Xcode can't find the key in source any more |
| `duplicateValues` | warn | Two keys with the identical source string — paid for and reviewed twice |
| `orphanKeys` | warn | Translations exist but the source string is gone |
| `pluralCoverage` | warn | Missing CLDR plural categories |
| `identicalToSource` | off | Translation byte-identical to the source string |

Format specifiers compare by argument position, so a legitimate reorder passes and a type swap
fails with `expected %lld at position 1, found %@`. Plural coverage uses a built-in CLDR table:
Polish needs `one/few/many/other`, Japanese only `other`.

Reads `.xcstrings`, plural `substitutions`, legacy `.strings`/`.stringsdict`, and SwiftPM package
resources. Skips `Pods`, `Carthage`, `.build`, `DerivedData` and `node_modules`.

---

## What your reviewers see

> ### 🌍 xcstrings-lint — **failed**
>
> **24 issues** — 4 keys across 8 languages.
>
> | Languages | Missing | Empty | Format | Total |
> |---|---|---|---|---|
> | `de` | 2 | 1 | 1 | **4** |
> | `es`, `it`, `ja`, `ko`, `pt-BR`, `zh-Hans` | 3 | — | — | **3** |
> | `fr` | 2 | — | — | **2** |
>
> <details><summary><b>Missing translations</b> · 22</summary>
>
> | Key | Languages |
> |---|---|
> | `payment_save_card_subtitle` | all 8 languages |
> | `payment_save_card_title` | all 8 languages |
> | `payment_cvv_hint` | `es`, `it`, `ja`, `ko`, `pt-BR`, `zh-Hans` |
>
> </details>
>
> <details><summary><b>Format specifier mismatches</b> · 1</summary>
>
> - `cart_item_count` — de: expected %lld at position 1, found %@
>
> </details>
>
> <details><summary><b>Warnings</b> · 3 — not blocking</summary>
>
> **Duplicate source strings** · 1
>
> - `checkout_title` — "checkout_title" has the same source text as "cart_title"
>
> </details>
>
> <sub>12 files checked · 3 warnings</sub>

Languages that broke the same way share a row, so eight locales missing the same three keys is one
line, not eight. Detail stays collapsed until someone wants it, and warnings never count against
the verdict.

One sticky comment, updated in place on every push, plus inline annotations and a job summary that
works even on fork pull requests.

---

## A scan that finds nothing is an error

If the configured globs match no files, the action **fails with exit 2** and names the patterns it
searched. It does not report a pass.

This is the one failure mode that looks exactly like success: a wrong `paths` entry, a renamed
directory or a missing checkout step turns the check permanently green while it reads nothing at
all. A linter that has been quietly switched off is worse than no linter, because everyone believes
it is working.

---

## Rolling it out

1. Add the workflow with `continue-on-error: true` — reports appear, nothing blocks.
2. Work the list down. `threshold` lets you ratchet a number up over time if the backlog is large:
   start at today's coverage and raise it.
3. Once the reports are boring, delete `continue-on-error`.
4. **Settings → Branches** → your `main` rule → **Require status checks to pass** → tick
   **`Localization / check`**.

That check name is `<workflow name> / <job name>` from your YAML, and it only appears in the list
after it has run on a pull request once.

---

## Configuration

`.xcstrings-lint.yml` at the repo root. Every field is optional, and so is the file.

```yaml
paths: ['**/*.xcstrings', '**/*.strings']
sourceLanguage: en
required: [de, fr, ja]
failOn: [missing, empty, new]
warnOn: [needsReview, stale]
ignore:
  keys: ['app_name', 'OK']
  patterns: ['debug_*']
  files: ['**/Tests/**']
formatSpecifiers: error
pluralCoverage: warn
duplicateKeys: error
duplicateValues: warn
orphanKeys: warn
identicalToSource: off
```

| Option | Default | Notes |
|---|---|---|
| `paths` | `**/*.xcstrings`, `**/*.strings`, `**/*.stringsdict` | Which catalogs to read |
| `sourceLanguage` | each catalog's own | Override only if the catalog is wrong |
| `required` | every language found | Languages to gate on |
| `failOn` | `[missing, empty, new]` | State classes that fail the run |
| `warnOn` | `[needsReview, stale]` | State classes that report but never fail |
| `ignore.keys` | — | Exact key names to skip |
| `ignore.patterns` | — | Key globs, e.g. `debug_*` |
| `ignore.files` | — | File globs |
| `formatSpecifiers` | `error` | `error` \| `warn` \| `off` |
| `pluralCoverage` | `warn` | `error` \| `warn` \| `off` |
| `duplicateKeys` | `error` | `error` \| `warn` \| `off` |
| `duplicateValues` | `warn` | `error` \| `warn` \| `off` |
| `orphanKeys` | `warn` | `error` \| `warn` \| `off` |
| `identicalToSource` | `off` | `error` \| `warn` \| `off` |

Things worth knowing:

- **An explicit list replaces the default, it doesn't extend it.** `failOn: [missing]` means *only*
  `missing` fails. Listing a class in both `failOn` and `warnOn` is a config error.
- **`needs_review` still counts as translated** in the percentage, matching Xcode's own figure. It
  is reported separately, as a warning.
- **Coverage never rounds up.** 2999 of 3000 strings reads as `99.9%`, not `100%`, and the
  threshold gate compares counts rather than the displayed figure — so `threshold: 100` means every
  string, not "a number that rounds to 100".
- **Listing your source language in `required` is fine.** It has nothing to translate into, so it
  is skipped rather than reported at 0%.
- **`identicalToSource` is off by default** because "Cancel", "Email" and every product name in the
  catalog are legitimately identical in a dozen languages. Turn it on once your proper nouns live
  in `ignore.keys`.
- **A malformed config gets a pointed error, never a stack trace** — the offending key and the
  values it accepts.

### Inputs and outputs

| Input | Default | Output | Example |
|---|---|---|---|
| `config` | `.xcstrings-lint.yml` | `passed` | `false` |
| `threshold` | `100` | `coverage` | `{"de":100,"fr":98.8}` |
| `comment` | `true` | `issue-count` | `5` |
| `annotations` | `true` | `warning-count` | `2` |
| `fail` | `true` | `files-scanned` | `12` |
| `github-token` | `${{ github.token }}` | `report` | Markdown report body |

---

## Recipes

| Want | Add to `with:` |
|---|---|
| Report without ever blocking | `fail: false` |
| Allow a backlog, block regressions below it | `threshold: 92` |
| Annotations only, no comment | `comment: false` |
| Gate only some languages | `required: [de, fr]` in the config file |

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Passed, or issues found with `fail: false` |
| `1` | Blocking issues found |
| `2` | Misconfiguration, an unreadable file, or globs that matched nothing |

`2` always names the file or option at fault — a file that couldn't be parsed is never quietly
reported as 100% covered.

---

## Upgrading from v1

v1 defaulted to **ratchet mode**, which compared the branch against its merge base and reported only
what that branch introduced. It has been removed. The comparison was the source of most of the
tool's complexity and all of its sharp edges — shallow clones, missing base refs, `fetch-depth: 0`,
"works on pull requests but not on push" — and it answered a narrower question than the one people
actually have, which is *"is my app fully translated?"*.

To upgrade:

1. Change `@v1` to `@v2`.
2. Delete `mode:` from your workflow if it is there. It is accepted and ignored, with a notice.
3. `fetch-depth: 0` on the checkout step is no longer needed; a shallow checkout is fine.
4. Expect a bigger first report. v2 shows the whole backlog, not just the delta. If that is too
   much to fix at once, start with `fail: false`, or set `threshold` to your current coverage and
   raise it over time.

Also new in v2: duplicate keys, duplicate source strings, orphan keys and an optional
identical-to-source check; a coverage figure that no longer rounds up to 100; and an empty scan
failing instead of passing.

---

## Fork pull requests

`GITHUB_TOKEN` is read-only on fork pull requests, so the comment API returns 403. The action logs a
notice and carries on — annotations and the job summary still work, and the job does **not** fail.
It deliberately doesn't suggest `pull_request_target`, which runs with a writable token and access
to secrets in the base repository's context.

---

## Contributing

```bash
npm ci
npm test          # vitest
npm run typecheck
npm run build     # rebuilds dist/
```

Node version is pinned in `.nvmrc`. The source is laid out as:

```
src/
  main.ts            GitHub Actions entry point
  action/            input parsing and the comment API — the only files that know about Actions
  lint.ts            the whole check in one call: config -> scan -> analyze -> verdict
  core/
    scan.ts          find and parse every catalog
    assess.ts        read each (key, language) pair once, for every check to share
    analyze.ts       run the rules
    coverage.ts      the percentage and the threshold gate
    rules/           one file per check
    parse/           .xcstrings, .strings, .stringsdict and format-specifier grammars
  report/            markdown for the comment, the job summary and the annotations
```

Adding a check is a file in `core/rules/`, an entry in `rules/index.ts` and a severity in
`core/config.ts`. Nothing else needs to know it exists.

A few things worth knowing before you open a PR:

- **`dist/` is committed and CI checks it.** GitHub doesn't build JS actions, so if `dist/` drifts
  from `src/` the action silently runs old code. Run `npm run build` and commit the result.
- **Fixtures live in `__tests__/fixtures/`** — deliberately broken catalogs covering every issue
  class. Add one alongside any new check.
- **`self-check.yml` runs the action against those fixtures** on every PR, so the real bundle is
  exercised in a real runner.

Bug reports are most useful with the `.xcstrings` snippet that triggered them.

---

## Scope

**In scope** — `.xcstrings`, legacy `.strings` and `.stringsdict`, plural `substitutions`, the
checks above, and the three report surfaces.

**Out of scope, deliberately** — machine translation or auto-fix commits, XLIFF / `.xcloc`, Android
`strings.xml`, TMS integrations, a web dashboard, and a standalone CLI. Each is a different product,
and bolting them on is how a focused tool turns into a slow one.

## License

MIT

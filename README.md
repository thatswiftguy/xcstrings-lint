# xcstrings-lint

**Catch missing, duplicate and broken iOS translations before they merge.**

[![Test](https://github.com/thatswiftguy/xcstrings-lint/actions/workflows/test.yml/badge.svg)](https://github.com/thatswiftguy/xcstrings-lint/actions/workflows/test.yml)
[![Self-check](https://github.com/thatswiftguy/xcstrings-lint/actions/workflows/self-check.yml/badge.svg)](https://github.com/thatswiftguy/xcstrings-lint/actions/workflows/self-check.yml)

- Xcode shows a completion percentage and never fails the build.
- A string gets added, translated into one or two languages, and the rest ship as raw key IDs.
- Every run reads **every catalog in the repo** and reports the whole picture.
- When a base branch is available, it also tells you **which problems your change introduced**.
- Runs on `ubuntu-latest`. No Xcode, no macOS runner — `.xcstrings` is just JSON.

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
      - uses: thatswiftguy/xcstrings-lint@main
```

No config file needed.

---

## What it catches

| Check | Default | Means |
|---|---|---|
| `missing` | **fail** | No entry for that key in that language |
| `empty` | **fail** | Entry exists, value is `""` |
| `new` | **fail** | Extracted by Xcode, never translated |
| `duplicateKeys` | **fail** | Same key twice in one file — one copy is silently discarded |
| `formatSpecifiers` | **fail** | `%lld` vs `%@` — a runtime crash, not a cosmetic slip |
| `needsReview` | warn | Marked `needs_review` |
| `stale` | warn | Xcode can't find the key in source any more |
| `duplicateValues` | warn | Two keys, identical source string — paid for and reviewed twice |
| `orphanKeys` | warn | Translations exist, source string is gone |
| `pluralCoverage` | warn | Missing CLDR plural categories |
| `identicalToSource` | off | Translation byte-identical to the source |

- Format specifiers compare **by argument position** — a legitimate reorder passes, a type swap fails with `expected %lld at position 1, found %@`.
- Plural coverage uses a built-in CLDR table — Polish needs `one/few/many/other`, Japanese only `other`.
- Reads `.xcstrings`, plural `substitutions`, legacy `.strings`/`.stringsdict`, and SwiftPM resources.
- Skips `Pods`, `Carthage`, `.build`, `DerivedData`, `node_modules`.

---

## Two modes

Both read the whole repo and report everything. The only difference is **what blocks the merge**.

| Mode | Blocks on | Use when |
|---|---|---|
| `full` *(default)* | Every issue | You want the whole catalog clean |
| `ratchet` | Only issues **your change introduced** | You have a backlog and want to stop it growing |

```yaml
- uses: thatswiftguy/xcstrings-lint@main
  with:
    mode: ratchet
```

- Either way, pre-existing problems are listed in their own collapsed section, so a reviewer can tell at a glance what is theirs.
- The comparison is against the **merge base**, so work that landed on the base branch since you branched isn't blamed on you.
- It's **semantic, never textual** — Xcode rewrites large regions of `.xcstrings` JSON on every build, so a text diff is noise.
- No base branch available? `full` degrades to reporting everything without the split. `ratchet` fails — it has nothing to ratchet against.

---

## A scan that finds nothing is an error

If the globs match no files, the action **fails with exit 2** and names the patterns it searched.

- A wrong `paths` entry or a missing checkout turns the check permanently green while reading nothing.
- That is the one failure mode that looks exactly like success.

---

## Rolling it out

1. Add the workflow with `continue-on-error: true` — reports appear, nothing blocks.
2. Switch to `mode: ratchet` so the backlog stops growing while you work it down.
3. Or set `threshold` to today's coverage and raise it over time.
4. Drop `continue-on-error`, then require the check in **Settings → Branches**.

The check name is `<workflow name> / <job name>`, and it only appears in the list after it has run on a pull request once.

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

| Option | Default |
|---|---|
| `paths` | `**/*.xcstrings`, `**/*.strings`, `**/*.stringsdict` |
| `sourceLanguage` | each catalog's own |
| `required` | every language found |
| `failOn` | `[missing, empty, new]` |
| `warnOn` | `[needsReview, stale]` |
| `ignore.keys` / `ignore.patterns` / `ignore.files` | — |
| `formatSpecifiers` · `duplicateKeys` | `error` |
| `pluralCoverage` · `duplicateValues` · `orphanKeys` | `warn` |
| `identicalToSource` | `off` |

Worth knowing:

- **An explicit list replaces the default, it doesn't extend it.** `failOn: [missing]` means *only* `missing` fails. Listing a class in both `failOn` and `warnOn` is a config error.
- **`needs_review` still counts as translated** in the percentage, matching Xcode's own figure. Reported separately, as a warning.
- **Coverage never rounds up.** 2999 of 3000 reads as `99.9%`, and the threshold compares counts — so `threshold: 100` means every string, not "a number that rounds to 100".
- **Your source language in `required` is fine.** Nothing to translate into, so it's skipped rather than reported at 0%.
- **`identicalToSource` is off by default** — "Cancel", "Email" and product names are legitimately identical in a dozen languages. Turn it on once your proper nouns are in `ignore.keys`.
- **A bad config gets a pointed error, never a stack trace.**

---

## Inputs and outputs

| Input | Default | | Output | Example |
|---|---|---|---|---|
| `config` | `.xcstrings-lint.yml` | | `passed` | `false` |
| `mode` | `full` | | `coverage` | `{"de":100,"fr":98.8}` |
| `threshold` | `100` | | `issue-count` | `5` |
| `comment` | `true` | | `warning-count` | `2` |
| `annotations` | `true` | | `pre-existing-count` | `28` |
| `fail` | `true` | | `files-scanned` | `12` |
| `github-token` | `${{ github.token }}` | | `report` | Markdown body |

Recipes:

| Want | Add to `with:` |
|---|---|
| Report without ever blocking | `fail: false` |
| Block only on new problems | `mode: ratchet` |
| Allow a backlog, block below it | `threshold: 92` |
| Annotations only, no comment | `comment: false` |
| Gate only some languages | `required: [de, fr]` in the config file |

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Passed, or issues found with `fail: false` |
| `1` | Blocking issues found |
| `2` | Misconfiguration, an unreadable file, or globs that matched nothing |

`2` always names the file or option at fault — a file that couldn't be parsed is never quietly reported as 100% covered.

## License

MIT

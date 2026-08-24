# xcstrings-lint

**Catch missing iOS translations before they merge.**

[![Test](https://github.com/thatswiftguy/xcstrings-lint/actions/workflows/test.yml/badge.svg)](https://github.com/thatswiftguy/xcstrings-lint/actions/workflows/test.yml)
[![Self-check](https://github.com/thatswiftguy/xcstrings-lint/actions/workflows/self-check.yml/badge.svg)](https://github.com/thatswiftguy/xcstrings-lint/actions/workflows/self-check.yml)

Xcode shows a completion percentage in the String Catalog editor and never fails the build. A
developer adds a string, translates it into one or two languages, and the rest ship as raw key IDs.
The pull request is the last place that is still cheap to fix.

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
        with: { fetch-depth: 0 }
      - uses: thatswiftguy/xcstrings-lint@v1
```

That's the whole thing — no config file needed. `fetch-depth: 0` lets the default ratchet mode see
the base branch; without it you get a warning and a less precise comparison, not a failure.

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

One sticky comment, updated in place on every push, plus inline annotations and a job summary that
works even on fork pull requests.

---

## Contributing

```bash
npm ci
npm test          # vitest, 220 tests
npm run typecheck
npm run build     # rebuilds dist/
```

Node version is pinned in `.nvmrc`. A few things worth knowing before you open a PR:

- **`dist/` is committed and CI checks it.** GitHub doesn't build JS actions, so if `dist/` drifts
  from `src/` the action silently runs old code. Run `npm run build` and commit the result.
- **Fixtures live in `__tests__/fixtures/`** — deliberately broken catalogs covering every issue
  class. Add one alongside any new check.
- **`self-check.yml` runs the action against those fixtures** on every PR, so the real bundle is
  exercised in a real runner.

Bug reports are most useful with the `.xcstrings` snippet that triggered them.

---

## What it catches

| Check | Default |
|---|---|
| `missing` — no entry in that language | **fail** |
| `empty` — entry exists, value is `""` | **fail** |
| `new` — extracted by Xcode, never touched | **fail** |
| `needsReview` — marked `needs_review` | warn |
| `stale` — Xcode can't find the key in source | warn |
| `formatSpecifier` — `%lld` vs `%@`, a runtime crash | **fail** |
| `pluralCoverage` — missing CLDR plural categories | warn |

Format specifiers compare by argument position, so a legitimate reorder passes and a type swap
fails with `expected %lld at position 1, found %@`. Plural coverage uses a built-in CLDR table:
Polish needs `one/few/many/other`, Japanese only `other`.

Reads `.xcstrings`, plural `substitutions`, legacy `.strings`/`.stringsdict`, and SwiftPM package
resources. Skips `Pods`, `Carthage`, `.build`, `DerivedData` and `node_modules`.

---

## Ratchet mode

An absolute gate fails on the first pull request of any real project and gets switched off within a
week. Ratchet mode reports only what **your branch** introduced — *"you added 3 strings and
translated 0 of them"*, not *"your project is 87% translated"*.

The gate is the set of newly-introduced `(catalog, key, language)` problems, **not** a coverage
percentage. That matters: add ten translated strings plus one untranslated one and your percentage
goes *up* while you ship an untranslated string. A percentage gate waves that through; a set
difference doesn't. Percentages still appear in the report — as information, not as the gate.

Two details keep it fair. The comparison is against the **merge base**, so work that landed on
`main` since you branched isn't blamed on you. And it's **semantic, never textual**, because Xcode
rewrites large regions of `.xcstrings` JSON on every build.

---

## Rolling it out

1. Add the workflow with `continue-on-error: true` — reports appear, nothing blocks.
2. Once the reports are boring, delete that line.
3. **Settings → Branches** → your `main` rule → **Require status checks to pass** → tick
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
```

| Option | Default | Notes |
|---|---|---|
| `paths` | `**/*.xcstrings`, `**/*.strings`, `**/*.stringsdict` | Which catalogs to read |
| `sourceLanguage` | each catalog's own | Override only if the catalog is wrong |
| `required` | every language found | Languages to gate on |
| `failOn` | `[missing, empty, new]` | Classes that fail the run |
| `warnOn` | `[needsReview, stale]` | Classes that report but never fail |
| `ignore.keys` | — | Exact key names to skip |
| `ignore.patterns` | — | Key globs, e.g. `debug_*` |
| `ignore.files` | — | File globs |
| `formatSpecifiers` | `error` | `error` \| `warn` \| `off` |
| `pluralCoverage` | `warn` | `error` \| `warn` \| `off` |

Three behaviours worth knowing:

- **An explicit list replaces the default, it doesn't extend it.** `failOn: [missing]` means *only*
  `missing` fails. Listing a class in both `failOn` and `warnOn` is a config error.
- **`needs_review` still counts as translated** in the percentage, matching Xcode's own figure. It
  is reported separately, as a warning.
- **A malformed config gets a pointed error, never a stack trace** — the offending key and the
  values it accepts.

### Inputs and outputs

| Input | Default | Output | Example |
|---|---|---|---|
| `config` | `.xcstrings-lint.yml` | `passed` | `false` |
| `mode` | `ratchet` | `coverage` | `{"de":100,"fr":98.8}` |
| `threshold` | `100` | `issue-count` | `5` |
| `comment` | `true` | `report` | Markdown report body |
| `annotations` | `true` | | |
| `fail` | `true` | | |
| `github-token` | `${{ github.token }}` | | |

---

## Recipes

| Want | Add to `with:` |
|---|---|
| Report without ever blocking | `fail: false` |
| Full coverage before a release | `mode: absolute` (see below) |
| Annotations only, no comment | `comment: false` |
| Gate only some languages | `required: [de, fr]` in the config file |

Strict on release branches, ratchet everywhere else:

```yaml
mode: ${{ startsWith(github.ref, 'refs/heads/release/') && 'absolute' || 'ratchet' }}
```

Scheduled runs have no base branch, so a weekly report needs `mode: absolute` and `fail: false`.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Passed, or issues found with `fail: false` |
| `1` | Blocking issues found |
| `2` | Misconfiguration, unreadable file, or missing base ref |

`2` always names the file or option at fault — a file that couldn't be parsed is never quietly
reported as 100% covered.

---

## Fork pull requests

`GITHUB_TOKEN` is read-only on fork pull requests, so the comment API returns 403. The action logs a
notice and carries on — annotations and the job summary still work, and the job does **not** fail.
It deliberately doesn't suggest `pull_request_target`, which runs with a writable token and access
to secrets in the base repository's context.

---

## Roadmap

Not in v1, roughly in order of likelihood:

- [ ] Machine translation and auto-fix pull requests
- [ ] XLIFF and `.xcloc` support
- [ ] Checks API batching, for more than ~10 annotations per run
- [ ] A standalone CLI, for pre-commit hooks and Xcode build phases
- [ ] TMS integrations (Lokalise, Crowdin, Phrase)
- [ ] Android `strings.xml`
- [ ] A web dashboard

## License

MIT

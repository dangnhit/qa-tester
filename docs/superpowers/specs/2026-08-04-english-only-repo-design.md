# English-only repository

Eleven commit messages, two design documents, two test files, and one README are written in Vietnamese. This makes the repository bilingual by accident rather than by decision. The fix states the decision, removes the Vietnamese prose, and installs a gate so the rule survives the next contributor.

The hard part is not deletion. It is drawing the boundary, because this project ships Vietnamese on purpose.

## The boundary

**Artifact Locale is a product feature.** `CONTEXT.md` already settles it:

> **Domain expert:** "No. **Artifact Locale** affects only the human-readable projection; machine values remain canonical English."

A report rendered with `locale: "vi"` is Vietnamese by contract. The data behind that projection is product output, not repository prose, and it stays:

| Path | Why it stays |
| --- | --- |
| `src/reporting/render-markdown.ts` | The `vi` label table the renderer substitutes |
| `shared/templates/report.vi.md` | The `vi` template, loaded by locale at `render-markdown.ts:18` |
| `tests/fixtures/report-golden.vi.md` | The golden the `vi` projection is diffed against |
| `tests/reporting/render.test.ts` | Asserts the rendered `vi` heading |
| `tests/operations/report-generation.integration.test.ts` | Asserts the same heading end to end |

`shared/templates/report.vi.md` is pure ASCII placeholders, so no scanner ever flags it, but deleting it breaks `vi` rendering. It is listed here so nobody mistakes it for a stray translation.

Everything else authored in this repository is English: commit messages, code, comments, documentation, issues, pull requests.

## What is being fixed

| What | Where | Action |
| --- | --- | --- |
| 11 commit messages | `7546c79`, and `50d63ad` through the merge `799c7ba` | Rewrite in English |
| Phase 10 design | `docs/superpowers/specs/2026-08-03-v1.0-contract-freeze-design.md` | Translate in full |
| Phase 10 plan | `docs/superpowers/plans/2026-08-03-v1.0-contract-freeze.md` | Translate in full |
| Vietnamese code comments | `tests/installer/compatibility.test.ts`, `tests/installer/legacy-manifest.test.ts` | Translate |
| Vietnamese quickstart | `docs/README.vi.md` | Delete, and drop its two live references in `docs/IMPLEMENTATION_PLAN.md` |
| Non-ASCII filename fixture | `src/reporting/projections/sarif.ts`, `tests/reporting/projections/sarif.test.ts`, `tests/reporting/projections/spec-locations.test.ts` | The Vietnamese spec filename becomes `e2e/テスト.spec.ts` |

The fixture exists only to be non-ASCII, so a non-Vietnamese non-ASCII string serves the test's intent exactly as well and keeps the allowlist at four entries instead of seven. Every exemption is a slot a future Vietnamese string can hide in, so the allowlist is kept as small as the feature requires.

`docs/superpowers/plans/2026-07-23-qa-skills-mvp.md` still names `docs/README.vi.md` in two places. It is an archived plan describing what was built in July, its references are ASCII, and rewriting an executed plan to erase a file that existed at the time would falsify the record. Left alone.

## The detector

One scanner, `scripts/check-language.ts`, called from three places so no two gates can disagree. It follows the shape of `scripts/check-secrets.ts`: walk `git ls-files`, collect findings, exit 1 with the list or print a one-line pass.

Three modes:

- `--files` -- every tracked file except binaries and the four allowlisted locale assets
- `--message <path>` -- one commit message, with git's `#` comment lines stripped
- `--history [range]` -- every commit message in the range, reported by short SHA and line

### Why not "no non-ASCII"

Measured, not assumed. **151 tracked files contain a non-ASCII byte**, nearly all of it em dashes and typographic quotes in legitimate English prose. A non-ASCII ban would demand rewriting the typography of the entire repository, and it would also reject `64fe203`, whose English subject uses an em dash.

### Why not "no Latin diacritic"

Because `façade` appears in `src/planning/coverage.ts` and is English usage. The scanner therefore matches the **Vietnamese alphabet specifically** -- the precomposed letters in `U+1EA0..U+1EF9`, the individual accented forms Vietnamese shares with other Latin scripts, and the breve, circumflex, horn, and stroked-d forms (`U+0102`, `U+0103`, `U+0110`, `U+0111`, `U+01A0`, `U+01A1`, `U+01AF`, `U+01B0`). It deliberately excludes c-cedilla, n-tilde, o-umlaut, u-umlaut, i-diaeresis, a-ring, o-slash, and eszett, none of which are Vietnamese letters.

The spec you are reading names those exclusions in words rather than glyphs for a reason: a document describing the ban must not itself trip it.

Measured precision: the class matches **12 tracked files, with zero false positives**. Every match is either genuine Vietnamese prose or a locale asset. Widening the class from "Vietnamese-only markers" to "the full Vietnamese alphabet" added exactly two files, both locale assertions.

The character class is written as `\uXXXX` escapes so the scanner is itself pure ASCII and never needs to exempt itself. Input is normalized to NFC before matching, so decomposed Vietnamese cannot slip past a precomposed class.

### Known limit, stated rather than hidden

Unaccented Vietnamese (`Ham nay quyet dinh...`) is invisible to any character-level scanner. The rule in `CONTRIBUTING.md` is the contract; the scanner is the cheap enforcement of its common case. This is written down so a future reader does not mistake a green gate for a proof.

## Enforcement

- **`.githooks/commit-msg`** runs `--message` on the message being written. Installed per clone with `npm run hooks:install`, which sets `core.hooksPath`. Hooks do not travel with a clone, which is why they are not the real gate.
- **CI job `language-scan`** runs `--files` and `--history HEAD`. It checks out with `fetch-depth: 0`, because the message half of the gate cannot read a shallow log. A machine that never installed the hook is still caught here.
- **`CONTRIBUTING.md`** gains a Language section stating the rule, the single exception, and the scanner's blind spot.
- **`docs/IMPLEMENTATION_PLAN.md`** has its Localization section corrected: it previously advertised the Vietnamese quickstart as policy.

## Rewriting the history

The range is `7546c79~1..HEAD` -- 65 commits, containing one merge commit (`799c7ba`, two parents). `7546c79` sits 64 commits back and would have been missed by reading subjects alone: its subject is English and its body quotes the Vietnamese fixture filename. It was found by running the scanner over the whole log, which is the reason the scanner was built before the rewrite rather than after.

Tool: `git filter-branch --msg-filter`. `git-filter-repo` is not installed and installing it is not worth a one-time run; `--msg-filter` preserves topology and leaves every tree byte-identical.

The 11 replacement messages are written ahead of time into a SHA-to-message table and reviewed before the rewrite runs. The filter looks up the current commit's SHA and returns the original message unchanged for the other 54. No translation happens while history is being rewritten.

Procedure, each step with its check:

1. `git branch backup/pre-english-rewrite` -- the way back.
2. Record `git rev-parse HEAD^{tree}`.
3. Run `filter-branch --msg-filter` over `7546c79~1..HEAD`.
4. **Trees unchanged:** `git diff backup/pre-english-rewrite HEAD` must be empty. Only messages moved.
5. **Topology unchanged:** commit count still 256, and `799c7ba`'s successor still has two parents.
6. **Gate green:** `npx tsx scripts/check-language.ts --history HEAD` passes.
7. `git push --force-with-lease origin main` -- `--force-with-lease`, not `--force`, so a remote that moved since the check aborts the push instead of losing work.

Measured blast radius: `main == origin/main`, 0 forks, 0 tags, 0 open pull requests, no branch protection or rulesets on `main`, one worktree, clean tree. The rewrite changes SHAs for 65 commits and breaks nobody.

## Rewriting the file contents inside history

Rewriting messages leaves `git show <old commit>:<path>` producing Vietnamese, because that is what the file said at that commit. A second pass closes it, over the whole of `main` rather than one range, since `docs/README.vi.md` existed from the MVP.

Measured first: **26 blobs across 8 paths** carry Vietnamese outside the Artifact Locale assets, out of 1,754 blobs in history. Small enough to treat each one deliberately rather than sweeping.

| Paths | Blobs | Treatment |
| --- | --- | --- |
| `sarif.ts`, `sarif.test.ts`, `spec-locations.test.ts` | 12 | Literal substitution of the fixture filename. Their only Vietnamese is that one string, so every intermediate edit survives byte-for-byte. |
| `legacy-manifest.test.ts` | 4 | Each contiguous Vietnamese comment run is replaced by the English block that says the same thing at HEAD, keyed by an ASCII marker inside the run. Table rows are rewritten row by row. |
| Phase 10 plan, Phase 10 spec, `compatibility.test.ts` | 3 | Replaced wholesale by the HEAD version. Each has exactly one Vietnamese blob in history, so no intermediate edit is collapsed. |
| `docs/README.vi.md` | 7 | Dropped from every tree. The file is deleted at HEAD, and translating seven versions of a document that no longer exists buys nothing. |

The replacements are written into the object database and verified **before** any commit is touched, so the `--index-filter` itself is a lookup of old blob SHA to new blob SHA and cannot invent content. Each replacement is re-scanned for Vietnamese as it is built, and the 17 TypeScript replacements are parsed with the TypeScript compiler before use.

Verification of the pass:

- **HEAD is untouched:** the tree hash is identical before and after (`b4faca9`), which is the proof that no current file changed.
- **Topology holds:** 261 commits, the merge still has two parents.
- **History is clean:** every blob reachable from `main` is scanned; the only Vietnamese left is in the five Artifact Locale paths, and `docs/README.vi.md` appears in no tree.

The five locale paths keep their Vietnamese in history for the same reason they keep it at HEAD. Note that `shared/templates/report.vi.md` is ASCII at HEAD but was Vietnamese in an earlier version, so it is exempt as a path rather than by its current contents.

## Verification

The full nine-command gate this project already uses, plus the new scanner:

```bash
npm run generate:types
npm run check:generated
npm run typecheck
npm run lint
npm test
npm run scan:secrets
npm run scan:language
npx tsx scripts/check-language.ts --history HEAD
npm run build
```

The scanner's own behavior is proven in both directions before it is trusted: a Vietnamese message must exit 1 and an English message must exit 0, measured directly rather than assumed, and the `commit-msg` hook must reject and accept the same two inputs through the hook path.

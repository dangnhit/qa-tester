# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

What "breaking" means here is exactly what [v1.0 froze](README.md#what-v10-freezes): the named
exports of `@dangnhit/qa-skills`, and the documented CLI commands, flags, and exit codes. The
`dist/` layout, internal module boundaries, helper names, and artifact JSON beyond its published
JSON Schema are implementation details and may change in a minor release.

## [Unreleased]

### Fixed

- `skills install --agent codex --target user` wrote its discovery shim to `~/AGENTS.md`. Codex
  reads global instructions from its Codex home (`~/.codex/AGENTS.md`, or `$CODEX_HOME`), so that
  install was never discovered — the exact failure ADR-0011 exists to close — and it left a stray
  file in the user's home directory. The shim now goes to `~/.codex/AGENTS.md`, and the block says
  which scope it was installed for instead of always claiming "this project".
- `skills verify` exited `5` (`ABORTED_OR_INTERNAL`) with a raw `ENOTDIR` when the skill bundle
  held any file at its root, because the drift walk assumed every managed top-level entry was a
  directory. It now reports such a file like any other managed file.
- Two high-severity advisories in the production dependency tree: `fast-uri`
  (GHSA-7p8r-x3mc-p8w7, reached through `ajv`) and `sharp` (GHSA-f88m-g3jw-g9cj, inherited libvips
  CVE-2026-33327/33328/35590/35591). `sharp` moves from `^0.34.3` to `^0.35.3`.

### Added

- `skills/NOTICE.md` ships inside the canonical bundle, so a copy installed into another
  repository does not arrive stripped of the license it is under.
- `fixtures/sarif/NOTICE.md` records the provenance and OASIS terms of the vendored SARIF 2.1.0
  schema, the one piece of third-party content in this repository. It is a test fixture and is
  absent from every published tarball.
- A Claude Code marketplace entry and a `qa-skills-bootstrap` plugin. The plugin carries one skill
  whose only job is to resolve the runtime and run `skills install`; it deliberately carries no
  copy of the eight canonical `SKILL.md` files, which would put a second definition outside the
  installer's checksum and Runtime Binding manifest.
- A tag-triggered release workflow that re-runs the full gate on the tagged commit, refuses when
  the tag and `package.json` disagree, and publishes with provenance behind a reviewed
  environment.
- `CODE_OF_CONDUCT.md`, and this changelog.

### Changed

- Published under a personal namespace: the package is `@dangnhit/qa-skills` and the schema `$id`
  base is `https://dangnhit.github.io/qa-tester/schemas/`.
- `NOTICE` now travels in the npm tarball (npm force-includes `LICENSE` but not `NOTICE`), no
  longer claims the package bundles its dependencies, and no longer cites a file absent from the
  tarball.
- `LICENSE` restores the `APPENDIX` heading and instruction paragraph, so the file is once again
  an unmodified copy of the Apache-2.0 text for automated license detection.
- README documents every path an install writes — including that `--agent codex` edits a
  marker-bounded block inside the user's own `AGENTS.md` — and that the `sharp` dependency runs an
  install hook which can compile libvips from source.
- `package.json` declares `publishConfig` (public access, provenance), a `prepack` build guard so
  a manual publish cannot ship a stale or unbuilt `dist/`, and a `./package.json` export subpath.

## [1.0.0] — 2026-08-05

First stable release; the public contract described above is frozen for the whole `1.x` range.

[Unreleased]: https://github.com/dangnhit/qa-tester/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/dangnhit/qa-tester/releases/tag/v1.0.0

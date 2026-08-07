---
name: qa-skills-setup
description: Install and verify the QA Skills runtime in this project so the eight canonical QA skills become available. Use when the user asks to set up QA Skills, when qa-skill is missing or its runtime binding is broken, or when a QA skill stopped with setup guidance.
---

# QA Skills setup

This skill installs a **runtime**, not skills of its own. The eight QA skills — `qa-tester`,
`requirement-analyzer`, `testcase-designer`, `test-data-manager`, `browser-test-executor`,
`evidence-collector`, `bug-reporter`, `qa-report-generator` — are written into the project by
`qa-skill skills install`, checksummed, and bound to the exact runtime binary that wrote them
(ADR-0011). This plugin carries no copy of them: a second copy could not be checked by
`qa-skill skills verify` and would drift from the canonical bundle silently.

Run the four steps below in order. Stop at the first one that does not succeed and report what it
said — do not work around a refusal, and do not continue to the next step on a non-zero exit.

## 1. Resolve the runtime

In this exact order: `./node_modules/.bin/qa-skill`, then `qa-skill` on `PATH`.

```sh
QA_SKILL="${PWD}/node_modules/.bin/qa-skill"; [ -x "$QA_SKILL" ] || QA_SKILL="$(command -v qa-skill)" || exit 1
```

PowerShell:

```powershell
$QaSkill = Join-Path $PWD "node_modules/.bin/qa-skill.cmd"
if (-not (Test-Path $QaSkill)) { $QaSkill = (Get-Command qa-skill -ErrorAction Stop).Source }
```

**Never** use `npx` against a remote registry, a globally cached binary of unknown origin, or any
substitute runtime. The QA Runtime's guarantees rest on the caller having reviewed the exact binary
that executes the run.

If neither path resolves, stop and give the user this setup, then wait — do not install packages on
their behalf:

```sh
npm install --save-dev @gwinnguyen/qa-skills
npx playwright install chromium
```

Node.js 22 or 24 is required. Chromium must be installed at setup time; QA execution never downloads a
browser or a package implicitly.

## 2. Verify the runtime version range

```sh
"$QA_SKILL" runtime verify --range ">=1.0.0 <2.0.0"
```

Prints JSON with `executable`, `version`, `range`, `compatible`. If `compatible` is `false`, the
installed package does not satisfy the v1 contract — report the printed version and stop. Do not
widen the range to make it pass.

## 3. Ask before writing, then install

`skills install` writes files into the user's project: `.claude/skills/<name>/SKILL.md` for each of the
eight skills, plus `.claude/skills/.qa-skill-manifest.json` recording every file's sha256 and the
Runtime Binding (command, real path, resolution source, version, executable checksum).

**Ask the user to confirm before running it.** Name the directory it will write to. Proceed only on an
explicit yes.

```sh
"$QA_SKILL" skills install --agent claude --target project
```

Use `--target user` instead only if the user asks for a home-directory installation. Project
installation is recommended: the runtime binding and the reviewed files then travel with the
repository.

`skills install` refuses to overwrite files an existing installation already wrote. If it refuses,
that is an existing install, not an error to force past — go to step 4 and read what `verify` says
about it.

## 4. Verify the installation

```sh
"$QA_SKILL" skills verify --agent claude --target project
```

`status` is one of:

| `status` | Meaning | Action |
| --- | --- | --- |
| `valid` | Files and Runtime Binding both match | Done — go to the handoff below |
| `missing` | An owned file, or the manifest itself, is absent | `skills update` |
| `modified` | An owned file was edited in place | `skills update`; `--force` only if the user knowingly discards the local edit |
| `unexpected` | A file exists in the install root that the manifest does not own | Show it to the user; do not delete it yourself |
| `runtime-missing` | The recorded runtime no longer resolves | Reinstall the package, then re-verify |
| `runtime-changed` | The resolved binary's identity no longer matches the binding | Re-verify after confirming which binary is correct; `skills update` rebinds |
| `runtime-incompatible` | The manifest's own `runtimeRange` differs from this build's | Read `reason` — it names both ranges as facts. `skills update --force` rewrites the manifest onto the range the binary **currently running** verifies, which is a downgrade if that binary is older than the one that wrote the manifest |

Never patch an installed file directly. Fix the canonical bundle upstream, then `verify` and `update`.

## Handoff

On `valid`, tell the user:

- which eight skills are now installed, and where
- that the session must be restarted for Claude Code to discover them
- that `qa-tester` is the orchestrator; the other seven are standalone specialists

Then stop. This skill has no further role — every QA request after this point goes to `qa-tester` or
to a specialist skill, and each of those resolves the same runtime the same way.

## What this skill must not do

- Author, edit, or copy any of the eight canonical `SKILL.md` files
- Author a `test-case`, `test-plan`, `requirement-analysis`, or `coverage-obligation` — those are the
  QA skills' own agent-authored drafts, produced inside a run
- Run `qa-skill workflow run`, `execute playwright`, or any other QA operation
- Install npm packages or a browser without the user asking
- Run `skills update --force` or `skills uninstall` without explicit confirmation of what is discarded

# Artifact authoring reference

The runtime accepts author-written drafts for exactly 4 artifact types — the only types ever
registered with `provenance: "agent-draft"`: `requirement-analysis`, `test-plan`, `test-case`, and
`coverage-obligation`. Every other artifact type (evidence, test results, bug reports, release gates,
reports, and so on) is runtime-produced; do not hand-author or hand-edit one. See
[artifact contracts](./artifact-contracts.md) for the general rules (immutability, provenance, English
enums, UTC timestamps) that apply to all of them.

Each section below gives the schema's literal path, a complete minimal valid example, which fields the
runtime derives (omit or treat as a placeholder), and how the type is actually registered. Every example
here is asserted valid against its schema by `tests/cli/artifact-authoring.test.ts` — an invalid example
in this doc would be worse than no doc. `qa-skill draft init --type <t>` prints exactly the same
skeleton shown here (for the 4 types listed below); use it instead of retyping these by hand.

## requirement-analysis

Schema: `dist/shared/schemas/requirement-analysis.schema.json`

Runtime-derived fields: none. Every field is author-supplied.

Register with:

```sh
qa-skill artifact ingest --root <path> --run-id <id> --type requirement-analysis --file <path>
```

Minimal valid example:

<!-- artifact-authoring:example requirement-analysis -->
```json
{
  "artifactType": "requirement-analysis",
  "schemaVersion": "1.0.0",
  "producerVersion": "1.0.0",
  "requirementAnalysisId": "REQUIREMENT-ANALYSIS-PLACEHOLDER",
  "statements": [
    {
      "requirementId": "REQ-PLACEHOLDER-1",
      "sourceProvenance": {
        "kind": "user",
        "reference": "PLACEHOLDER: cite the source (ticket, doc, code, or conversation)"
      },
      "normalizedText": "PLACEHOLDER: state one clear, testable requirement.",
      "authority": "AUTHORITATIVE",
      "role": "PLACEHOLDER: the user role this requirement applies to",
      "rules": [],
      "risks": [],
      "assumptions": [],
      "openQuestions": []
    }
  ]
}
```

## test-plan

Schema: `dist/shared/schemas/test-plan.schema.json`

Runtime-derived fields: **`approvalDecision`**. Do not set it. Workspace registration
(`RunWorkspace#withDerivedTestPlanApproval`) injects it from the plan, the registered
`requirement-analysis` artifacts, and the environment profile's classification; if the draft already has
an `approvalDecision`, registration throws `ARTIFACT_BINDING` — "Test plan approval decision is derived
by workspace registration and cannot be self-asserted." Omit the field entirely from the draft.

Register with:

```sh
qa-skill artifact ingest --root <path> --run-id <id> --type test-plan --file <path>
```

Minimal valid example (note there is no `approvalDecision` key):

<!-- artifact-authoring:example test-plan -->
```json
{
  "artifactType": "test-plan",
  "schemaVersion": "1.0.0",
  "producerVersion": "1.0.0",
  "testPlanId": "TEST-PLAN-PLACEHOLDER",
  "approvalPolicy": {
    "mode": "human-review"
  },
  "testCases": [
    {
      "testCaseId": "TC-PLACEHOLDER-1",
      "title": "PLACEHOLDER: short scenario title",
      "expectedResults": [
        {
          "id": "ER-PLACEHOLDER-1",
          "requirementId": "REQ-PLACEHOLDER-1",
          "authority": "AUTHORITATIVE",
          "text": "PLACEHOLDER: the expected, testable outcome."
        }
      ],
      "steps": [
        {
          "id": "step-1",
          "action": {
            "kind": "navigate",
            "url": "/placeholder"
          },
          "sideEffect": "none"
        }
      ],
      "openQuestions": []
    }
  ]
}
```

## test-case

Schema: `dist/shared/schemas/test-case.schema.json`

**There is no standalone `qa-skill artifact ingest --type test-case`.** `ingest-artifact.ts` routes only
`requirement-analysis`, `test-plan`, and `coverage-obligation`; passing `--type test-case` falls through
to its runtime-owned-boundary error. A `test-case` artifact is registered **only** as part of
`qa-skill workflow bootstrap`'s atomic batch, alongside the `requirement-analysis` and `test-plan` it
belongs to:

```sh
qa-skill workflow bootstrap --root <path> --environment-file <json> \
  --requirement-file <json> --plan-file <json> \
  --test-case-file <path> --coverage-file <path>
```

(`--test-case-file` and `--coverage-file` repeat for each test case / obligation in the batch.) This is
distinct from `test-plan.testCases`, which are the plan's own declarative descriptions of the same
scenarios — the standalone `test-case` artifact is the separate, execution-bound canonical revision.

Runtime-derived fields: none today. The schema only requires **`revisionId`** and **`instanceId`** to be
non-empty strings, and the runtime does **not** currently re-derive or verify either for a `test-case`
artifact — they are author-supplied identity anchors. Treat them as stable content-identity values
rather than arbitrary IDs. A convenient way to produce a stable digest for `revisionId` is:

```sh
qa-skill fingerprint --file <this-file>
```

`qa-skill fingerprint` is a general helper that prints the sha256 of a file's canonical JSON. Note it is
**not** an exact match for any internal derivation: it hashes the whole file as given, whereas
`createTestCaseRevision` (`src/planning/testcase-revision.ts`) strips `revisionId`/`fingerprint` and
hashes only the test-case shape. Likewise `instanceId` is conventionally
`"<testCaseId>--<first 16 hex characters of a fingerprint>"`, but the runtime's own instance expansion
(`src/planning/parameterization.ts`) derives that suffix from `{revisionId, parameters, browser}` — so
the value you write is an identity anchor the runtime records, not one it recomputes from this file.

Minimal valid example (`revisionId` / `instanceId` are placeholders — replace them with your own stable
identity values before registering):

<!-- artifact-authoring:example test-case -->
```json
{
  "artifactType": "test-case",
  "schemaVersion": "2.0.0",
  "producerVersion": "1.0.0",
  "testCaseId": "TC-PLACEHOLDER-1",
  "revisionId": "REPLACE_WITH_QA_SKILL_FINGERPRINT_OUTPUT",
  "instanceId": "TC-PLACEHOLDER-1--REPLACE_WITH_FIRST_16_HEX_CHARS_OF_FINGERPRINT",
  "title": "PLACEHOLDER: short scenario title",
  "steps": [
    {
      "id": "step-1",
      "action": "PLACEHOLDER: describe the action",
      "sideEffect": "none"
    }
  ],
  "coverage": {
    "requirementId": "REQ-PLACEHOLDER-1",
    "role": "PLACEHOLDER: the user role this covers",
    "behavior": "PLACEHOLDER: the behavior under test",
    "browser": "chromium",
    "viewport": {
      "width": 1280,
      "height": 720
    },
    "accessibilityMethod": null,
    "risk": "low",
    "outcome": "PLACEHOLDER: expected outcome"
  }
}
```

## coverage-obligation

Schema: `dist/shared/schemas/coverage-obligation.schema.json`

Runtime-derived fields: **`requirementAnalysisArtifactId`**, conditionally. Inside
`qa-skill workflow bootstrap`, this field is auto-filled by the batch's reference mechanism — it is bound
to the `requirement-analysis` artifact registered in the same batch, and whatever value the draft
contains is discarded and overwritten. For a standalone registration:

```sh
qa-skill artifact ingest --root <path> --run-id <id> --type coverage-obligation --file <path>
```

there is no such rewrite: the author **must** supply the real, already-registered `requirement-analysis`
artifact ID (find it in the run's `qa-results/<run-id>/artifact-manifest.json`, the `id` of the entry
with `"type": "requirement-analysis"`). Either way, the schema requires the field to already be a
non-empty string in the draft file, so a placeholder is still required even in the bootstrap path — it
is simply thrown away there.

**`executionSurface`** names the one **Execution Surface** the obligation is about, and is required:
`browser`, `api`, `unit`, `integration`, `performance`, `security`, or `manual`. It decides which other
fields the obligation may carry. `browser` and `viewport` describe the browser surface, so they are
**required when `executionSurface` is `"browser"` and forbidden on every other surface** — an `api`
obligation has no engine and no geometry, and writing one in would put a value into a checksummed
audit record that nothing ever measured.

Author obligations on every surface the requirement really needs, including ones this run will not
execute. The QA Runtime drives `browser` itself and reaches every other surface except `manual`
through a Runtime-Observed Execution (`qa-skill execute playwright` over a committed Playwright suite —
see [observed execution](./observed-execution.md)); `manual` has no executor in either lane. The
surfaces are deliberately not re-listed here: the enum above is this file's single listing, so it
cannot drift from a second copy the way this sentence did when lane 2 landed. An obligation no execution covers is reported as **explicitly unmet** in the release gate
(a `required` one blocks with `NOT_READY`, an optional one appears as a coverage gap), rather than
being silently omitted from the run's record — and that stays true of a reachable surface that this
particular run never observed.

**`accessibilityMethod`** is an enum, not free text, and is required on both `coverage-obligation` and
`test-case.coverage`. Write **`null`** — the common case — when the obligation names no accessibility
method at all. Otherwise pick exactly one of the four evaluation categories:

| value | means |
| --- | --- |
| `"automated-analysis"` | a machine analysis (e.g. a rule-based scan) |
| `"keyboard"` | a person evaluating with the keyboard alone |
| `"screen-reader"` | a person evaluating with a screen reader |
| `"cognitive-manual"` | a person's cognitive / manual review |

A label outside that list is rejected: an arbitrary string in a checksummed audit record is a claim
nothing can check.

**Declaring any method other than `null` makes this an accessibility obligation, and a passing test
result can no longer satisfy it.** A test case declaring the same method back at it earns nothing —
that is two labels agreeing with each other, with no screen reader, no human, and no artifact
anywhere in the run. Concretely:

- a **manual** method (`keyboard`, `screen-reader`, `cognitive-manual`) is satisfied only by a
  `human-attestation` bound to that obligation, recorded by a person with `qa-skill attestation
  record` (see below);
- `"automated-analysis"` is satisfied only by a machine artifact, and **this runtime ships no
  accessibility scanner** — so it stays explicitly unmet, exactly like an obligation on an
  unexecutable surface.

So an unattested `required` accessibility obligation blocks the release with `NOT_READY`, and an
optional one appears as a coverage gap. Write `null` unless you mean that.

Minimal valid example:

<!-- artifact-authoring:example coverage-obligation -->
```json
{
  "artifactType": "coverage-obligation",
  "schemaVersion": "3.0.0",
  "producerVersion": "1.0.0",
  "obligationId": "COV-PLACEHOLDER-1",
  "requirementId": "REQ-PLACEHOLDER-1",
  "requirementAnalysisArtifactId": "REPLACE_WITH_REGISTERED_REQUIREMENT_ANALYSIS_ARTIFACT_ID",
  "role": "PLACEHOLDER: the user role this covers",
  "behavior": "PLACEHOLDER: the behavior under test",
  "executionSurface": "browser",
  "browser": "chromium",
  "viewport": {
    "width": 1280,
    "height": 720
  },
  "accessibilityMethod": null,
  "risk": "low",
  "required": true,
  "outcome": "PLACEHOLDER: expected outcome"
}
```

## human-attestation (not an agent draft)

Schema: `dist/shared/schemas/human-attestation.schema.json`

A **Human Attestation** is an identified person's immutable signed claim that an evaluation no machine
performed was actually carried out. **An agent cannot author one across the ingestion boundary.** There
is no draft skeleton, and `qa-skill artifact ingest --type human-attestation` is refused there — the
whole point of the artifact is that a person, not an agent, made the claim through that path.
`qa-skill attestation record` (below) is a shell command exactly like `qa-skill approval record`; it can
be invoked the same way any command can. The only way this artifact is meant to enter a run is a person
running:

```sh
qa-skill attestation record --root <path> --run-id <id> \
  --obligation-id <obligationId> --method <keyboard|screen-reader|cognitive-manual> \
  --attested-by <identity> --statement "<what you actually did and observed>"
```

The runtime fills the rest: the attestation's ID, the run, the obligation's checksum, the timestamp,
and a `human-attestation:<identity>` provenance that no agent-draft path can write. It refuses to
record anything but a manual method (a person attesting to `automated-analysis` is a category error),
refuses unless exactly one registered obligation carries that `obligationId`, and refuses unless that
obligation declares the same `accessibilityMethod`. `--statement` is the substance of the claim and
must actually say something — without it the record only shows that somebody pressed a button.

### Where in a run this command belongs

`qa-skill workflow run` stops and waits for you. When a run reaches `generate-qa-report` — the operation
that writes the `release-gate` and the `qa-execution-report`, in `full` and `regression` modes — and a
**required** Coverage Obligation still declares a manual `accessibilityMethod` with no Human Attestation
bound to it, the workflow returns `outcome: "AWAITING_HUMAN_INPUT"` **without** generating the gate and
**without** finalizing the run. The workspace stays writable; exit code is `2` (`BLOCKED`).

The result body names the artifact:

```json
{
  "runId": "…",
  "outcome": "AWAITING_HUMAN_INPUT",
  "pendingHumanInput": {
    "kind": "attestation",
    "operation": "generate-qa-report",
    "command": "attestation record",
    "subjects": [{ "artifactId": "ART-…", "sha256": "…", "reference": "COV-A11Y", "method": "keyboard" }]
  }
}
```

Record it against that `runId`, then re-run `qa-skill workflow run` with the same input file plus
`"resumeRunId": "<runId>"`. The run reopens, skips every completed operation from its
`workflow-checkpoint`, re-checks the same condition, and — now that the attestation is registered —
generates a gate that credits it. `qa-skill approval record` has the same shape one operation earlier;
the full procedure for both is in
[recovery](./recovery.md#awaiting_human_input).

**Why the pause sits exactly there.** A release gate is an immutable snapshot of every artifact
registered up to the moment it is generated; registering a `human-attestation` afterward changes what a
re-derivation of the gate would produce, so the persisted gate permanently mismatches and gets flagged
(`ARTIFACT_BINDING`) the next time the workspace is read. `generate-qa-report` also refuses to run a
second time in the same run, so there is no regenerate-to-fix-it path. Immediately before the gate is
the last position at which the attestation can still count.

**What still will not work, and must not:**

- Staging one in a bootstrap run does not carry it forward. `qa-skill workflow bootstrap` finalizes its
  `plan` run, and `human-attestation` is not one of the four canonical planning types
  (`requirement-analysis`, `test-plan`, `test-case`, `coverage-obligation`), so a bundle import will not
  bring it across and `workflow scaffold` rejects a source run holding one. Record it at the pause, in
  the run that produces the gate.
- `qa-skill run create` gives a non-terminal run that accepts an ingested `coverage-obligation` and an
  attestation against it, but nothing generates a gate for a run built that way.
- An obligation nobody can attest to does **not** pause the run — it reaches the gate as `NOT_READY`.
  That covers `accessibilityMethod: "automated-analysis"` (no scanner ships here), an Execution Surface
  no executor covers, an obligation whose requirement is not `AUTHORITATIVE` (coverage credit requires
  one, so an attestation could not clear it), and an `obligationId` that two registered obligations
  share (the command refuses an ambiguous id). Authoring such an obligation with `required: false`
  reports it as an optional gap (`READY_WITH_RISKS`) — an honest "this was not covered", not a pass.

## CLI helpers

- `qa-skill schema show --type <t>` — print the compiled JSON Schema for any artifact type (not just the
  4 above) to stdout.
- `qa-skill draft init --type <t>` — print one of the 4 minimal valid examples above to stdout, ready to
  edit. Any other type is runtime-owned and errors instead of printing a skeleton.
- `qa-skill fingerprint --file <f>` — print the canonical-JSON sha256 of a file; a handy way to pick a
  stable `test-case` `revisionId`. It is a whole-file digest, not a value the runtime re-derives or
  verifies, so treat it as an author-supplied identity anchor rather than a checked fingerprint.

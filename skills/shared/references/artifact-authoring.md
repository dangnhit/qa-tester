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

Runtime-derived fields: **`revisionId` and `instanceId`**. The schema only requires non-empty strings, so
the runtime does not reject a hand-picked value today — but these two fields are meant to be the
artifact's immutable identity anchor, and should equal a content fingerprint, not an arbitrary ID.
Compute them with:

```sh
qa-skill fingerprint --file <this-file>
```

which runs `sha256Fingerprint` (`src/planning/testcase-revision.ts`) — the exact function
`createTestCaseRevision` uses to derive `revisionId`. Set `revisionId` to that hex digest, and
`instanceId` to `"<testCaseId>--<first 16 hex characters of the digest>"`.

Minimal valid example (`revisionId` / `instanceId` are placeholders — replace them per the above before
registering):

<!-- artifact-authoring:example test-case -->
```json
{
  "artifactType": "test-case",
  "schemaVersion": "1.0.0",
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

Minimal valid example:

<!-- artifact-authoring:example coverage-obligation -->
```json
{
  "artifactType": "coverage-obligation",
  "schemaVersion": "1.0.0",
  "producerVersion": "1.0.0",
  "obligationId": "COV-PLACEHOLDER-1",
  "requirementId": "REQ-PLACEHOLDER-1",
  "requirementAnalysisArtifactId": "REPLACE_WITH_REGISTERED_REQUIREMENT_ANALYSIS_ARTIFACT_ID",
  "role": "PLACEHOLDER: the user role this covers",
  "behavior": "PLACEHOLDER: the behavior under test",
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

## CLI helpers

- `qa-skill schema show --type <t>` — print the compiled JSON Schema for any artifact type (not just the
  4 above) to stdout.
- `qa-skill draft init --type <t>` — print one of the 4 minimal valid examples above to stdout, ready to
  edit. Any other type is runtime-owned and errors instead of printing a skeleton.
- `qa-skill fingerprint --file <f>` — print the sha256 content fingerprint of a JSON file; use it to
  compute a `test-case`'s `revisionId` (and derive `instanceId` from its first 16 hex characters) before
  registering the draft.

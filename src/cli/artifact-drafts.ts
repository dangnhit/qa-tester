import type { ArtifactType } from "../contracts/types.js";
import { runtimeVersion } from "../installer/manifest.js";

/**
 * The 4 artifact types an agent authors directly (the only types ever registered with
 * `provenance: "agent-draft"`). See `skills/shared/references/artifact-authoring.md`.
 */
export const agentDraftTypes = ["requirement-analysis", "test-plan", "test-case", "coverage-obligation"] as const satisfies readonly ArtifactType[];

export type AgentDraftType = (typeof agentDraftTypes)[number];

export function isAgentDraftType(value: string): value is AgentDraftType {
  return (agentDraftTypes as readonly string[]).includes(value);
}

/**
 * Minimal valid draft skeletons for the 4 agent-authored artifact types.
 *
 * These back both `qa-skill draft init --type <t>` and the canonical examples in
 * `skills/shared/references/artifact-authoring.md` (kept byte-for-byte in sync with this module by
 * `tests/cli/artifact-authoring.test.ts`, which parses the doc's fenced examples and asserts they
 * deep-equal these skeletons) — one source, no divergent copy.
 *
 * Runtime-derived fields are deliberately omitted or left as obvious placeholders:
 *  - `test-plan.approvalDecision` is injected by workspace registration
 *    (`RunWorkspace#withDerivedTestPlanApproval`) and throws `ARTIFACT_BINDING` if the draft sets it.
 *    It is OMITTED here — do not add it back.
 *  - `test-case.revisionId` / `instanceId` are author-supplied at registration today, but SHOULD equal
 *    the content fingerprint (`qa-skill fingerprint --file <this-file>`, which runs the exact same
 *    `sha256Fingerprint` that derives `revisionId`). Left as obvious placeholders.
 *  - `coverage-obligation.requirementAnalysisArtifactId` is auto-filled by `workflow bootstrap`'s batch
 *    reference mechanism (any value here is discarded in that path); a standalone
 *    `artifact ingest --type coverage-obligation` has no such rewrite and requires a real registered
 *    requirement-analysis artifact ID. Left as an obvious placeholder.
 */
export const agentDraftSkeletons: Readonly<Record<AgentDraftType, Readonly<Record<string, unknown>>>> = {
  "requirement-analysis": {
    artifactType: "requirement-analysis",
    schemaVersion: "1.0.0",
    producerVersion: runtimeVersion,
    requirementAnalysisId: "REQUIREMENT-ANALYSIS-PLACEHOLDER",
    statements: [
      {
        requirementId: "REQ-PLACEHOLDER-1",
        sourceProvenance: { kind: "user", reference: "PLACEHOLDER: cite the source (ticket, doc, code, or conversation)" },
        normalizedText: "PLACEHOLDER: state one clear, testable requirement.",
        authority: "AUTHORITATIVE",
        role: "PLACEHOLDER: the user role this requirement applies to",
        rules: [],
        risks: [],
        assumptions: [],
        openQuestions: [],
      },
    ],
  },
  "test-plan": {
    artifactType: "test-plan",
    schemaVersion: "1.0.0",
    producerVersion: runtimeVersion,
    testPlanId: "TEST-PLAN-PLACEHOLDER",
    approvalPolicy: { mode: "human-review" },
    testCases: [
      {
        testCaseId: "TC-PLACEHOLDER-1",
        title: "PLACEHOLDER: short scenario title",
        expectedResults: [
          { id: "ER-PLACEHOLDER-1", requirementId: "REQ-PLACEHOLDER-1", authority: "AUTHORITATIVE", text: "PLACEHOLDER: the expected, testable outcome." },
        ],
        steps: [
          { id: "step-1", action: { kind: "navigate", url: "/placeholder" }, sideEffect: "none" },
        ],
        openQuestions: [],
      },
    ],
  },
  "test-case": {
    artifactType: "test-case",
    schemaVersion: "3.0.0",
    producerVersion: runtimeVersion,
    testCaseId: "TC-PLACEHOLDER-1",
    revisionId: "REPLACE_WITH_QA_SKILL_FINGERPRINT_OUTPUT",
    instanceId: "TC-PLACEHOLDER-1--REPLACE_WITH_FIRST_16_HEX_CHARS_OF_FINGERPRINT",
    title: "PLACEHOLDER: short scenario title",
    steps: [
      { id: "step-1", action: "PLACEHOLDER: describe the action", sideEffect: "none" },
    ],
    coverage: {
      requirementId: "REQ-PLACEHOLDER-1",
      role: "PLACEHOLDER: the user role this covers",
      behavior: "PLACEHOLDER: the behavior under test",
      browser: "chromium",
      viewport: { width: 1280, height: 720 },
      accessibilityMethod: null,
      risk: "low",
      outcome: "PLACEHOLDER: expected outcome",
    },
  },
  "coverage-obligation": {
    artifactType: "coverage-obligation",
    schemaVersion: "4.0.0",
    producerVersion: runtimeVersion,
    obligationId: "COV-PLACEHOLDER-1",
    requirementId: "REQ-PLACEHOLDER-1",
    requirementAnalysisArtifactId: "REPLACE_WITH_REGISTERED_REQUIREMENT_ANALYSIS_ARTIFACT_ID",
    role: "PLACEHOLDER: the user role this covers",
    behavior: "PLACEHOLDER: the behavior under test",
    executionSurface: "browser",
    browser: "chromium",
    viewport: { width: 1280, height: 720 },
    accessibilityMethod: null,
    risk: "low",
    required: true,
    outcome: "PLACEHOLDER: expected outcome",
  },
};

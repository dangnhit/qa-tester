import type { ArtifactType } from "../contracts/types.js";
import { deriveTestPlanApproval, type ApprovalDecision, type ApprovalEnvironment } from "../planning/approval.js";
import { assertRequirementAuthorities } from "../planning/authority.js";
import { deriveReleaseGateFromWorkspaceArtifacts } from "../reporting/release-gate.js";
import type { ArtifactRecord } from "./artifact-record.js";
import type { ArtifactProfileName } from "./artifact-profiles.js";
import { array, canonicalJson, isRecord, uniqueResourceIds } from "./values.js";

/**
 * Shared semantic-rule abstraction (Phase 2a). One `Record<ArtifactType, SemanticRule>` is consumed
 * by BOTH the write path (`assertSemanticReferences`, throws `QaSkillsError`) and the read path
 * (`inspectWorkspaceState`, soft-invalidates → `INVALID_REFERENCE`). A rule COMPUTES the first
 * violation; each PATH decides how to react. The population of the related-artifact pool is supplied
 * by each path's adapter (`ctx.relatedOfType` / `ctx.registeredRecord`), so the write-vs-read cascade
 * asymmetry is reproduced without the rule knowing which path it runs on. See
 * `.superpowers/sdd/phase2a-design.md` §1–§5.
 *
 * This module imports TYPES + PURE HELPERS only. It MUST NOT import the `RunWorkspace` class:
 * cross-run access is injected via `ctx.openRun` (implemented by the adapters), which keeps this
 * module free of a static dependency on the class and therefore cycle-free.
 */

/** A rule computes a violation; each PATH decides how to react (write throws, read invalidates). */
export type SemanticViolation = {
  /** The WRITE-path error code. READ ignores this and always emits INVALID_REFERENCE with `message`
   *  (matching today: an authority mismatch is ARTIFACT_BINDING on write, INVALID_REFERENCE on read,
   *  same human-readable message). */
  code: "ARTIFACT_BINDING" | "UNSAFE_OPERATION";
  message: string;
};

export type SemanticStage = "write" | "read";

/** A related registered artifact, in a shape both paths can populate uniformly.
 *  `value` is undefined for binary media artifacts and for read-path artifacts that failed to bind. */
export type RelatedArtifact = Readonly<{
  record: Readonly<ArtifactRecord>;
  value?: Readonly<Record<string, unknown>>;
}>;

/** RunWorkspace.open-style access to a DISTINCT run, used by async cross-run rules
 *  (bug-report duplicate sources, retest source run). Backed by RunWorkspace.open + close. */
export type CrossRunView = Readonly<{
  readArtifactRecord(id: string): Promise<Readonly<ArtifactRecord>>;
  readRegisteredArtifacts(): Promise<readonly RelatedArtifact[]>;
  close(): Promise<void>;
}>;

export type SemanticContext = Readonly<{
  stage: SemanticStage;
  type: ArtifactType;

  /** The artifact under validation. On WRITE this is the to-be-persisted value
   *  (post-`withDerivedTestPlanApproval` for test-plan). On READ this is the persisted value. */
  value: Readonly<Record<string, unknown>>;
  /** The artifact's own manifest record. WRITE: not yet in the manifest, so a synthetic record whose
   *  `relationships` are the declared relationships and `id`/`sha256` are unset (""). READ: the real record. */
  self: Readonly<ArtifactRecord>;
  relationships: readonly string[];

  runId: string;                 // expected/own run id
  path: string;                  // workspace directory (…/qa-results/<runId>) — for file-level provenance
  root: string;                  // workspace root (dirname(dirname(path))) — for cross-run open
  linkedRunId: string | undefined;
  environmentProfileId: string;
  mode: ArtifactProfileName;

  /** The cascade-sensitive pool of RELATED registered artifacts. READ populates from the current
   *  valid set (mutated by earlier invalidation this pass); WRITE from the on-disk registered set
   *  (always valid). Same query, path-specific population = preserved cascade asymmetry. */
  relatedOfType(type: ArtifactType): readonly RelatedArtifact[];
  related(): readonly RelatedArtifact[];

  /** Manifest-record existence, INDEPENDENT of validity. Stable on both paths (backed by the full
   *  manifest, not the valid pool). Used where a rule must distinguish "record absent from the
   *  manifest" from "record present but not resolvable" — e.g. coverage-obligation's two messages. */
  registeredRecord(id: string, type?: ArtifactType): Readonly<ArtifactRecord> | undefined;

  /** Cross-run access for async rules. Caller must `close()` (adapters wrap RunWorkspace.open/close). */
  openRun(runId: string): Promise<CrossRunView>;
}>;

export type SemanticRule = Readonly<{
  type: ArtifactType;
  /** Lets a type opt a check into write-only / read-only / both. */
  appliesTo: { write: boolean; read: boolean };
  /** True if `evaluate` may return a Promise (cross-run / cross-file I/O). Documentation + a hint for
   *  the adapters; both adapters `await` regardless. */
  async: boolean;
  /** Compute the FIRST violation (short-circuit), or undefined if the artifact binds cleanly.
   *  One violation per evaluation matches write's throw-on-first and read's invalidate-on-first. */
  evaluate(ctx: SemanticContext): SemanticViolation | undefined | Promise<SemanticViolation | undefined>;
}>;

/** Rule: `requirement-analysis` — identical on both paths, no `ctx.stage` branch.
 *  Faithful to write `assertSemanticReferences` requirement-analysis branch (wraps the same throw as
 *  ARTIFACT_BINDING) and read `assertPersistedPlanningSemantics` (calls `assertRequirementAuthorities`
 *  directly; the fixpoint catch re-wraps as INVALID_REFERENCE with `error.message`). */
const requirementAnalysisRule: SemanticRule = {
  type: "requirement-analysis",
  appliesTo: { write: true, read: true },
  async: false,
  evaluate(ctx) {
    try {
      assertRequirementAuthorities(ctx.value);
    } catch (error) {
      return {
        code: "ARTIFACT_BINDING",
        message: error instanceof Error ? error.message : "Requirement authority verification failed",
      };
    }
    return undefined;
  },
};

/** Rule: `coverage-obligation` — carries the single sanctioned drift (drift 1). The "orphan analysis
 *  artifact" message keys on MANIFEST existence (`ctx.registeredRecord`, stable on both paths); the
 *  "orphan or ambiguous requirement" message keys on the cascade-sensitive valid pool
 *  (`ctx.relatedOfType`). A GENUINELY-MISSING record yields the specific message on both paths (drift
 *  1); a cascade-invalidated-but-still-registered record keeps the combined message (preserved).
 *  Faithful to write `assertCoverageObligationBinding` and read `assertPersistedPlanningSemantics`. */
const coverageObligationRule: SemanticRule = {
  type: "coverage-obligation",
  appliesTo: { write: true, read: true },
  async: false,
  evaluate(ctx) {
    const requirementId = ctx.value.requirementId;
    const analysisArtifactId = ctx.value.requirementAnalysisArtifactId;
    if (typeof requirementId !== "string" || typeof analysisArtifactId !== "string") {
      return { code: "ARTIFACT_BINDING", message: "Coverage obligation requirement binding is invalid" };
    }
    // DRIFT 1: key the "orphan analysis artifact" message on MANIFEST existence (stable on both
    // paths), NOT on the cascade-sensitive valid pool. Missing record => WRITE's specific message on
    // BOTH paths. See docs/reports/semantic-rule-drift.md item 1.
    const record = ctx.registeredRecord(analysisArtifactId, "requirement-analysis");
    if (!record) {
      return {
        code: "ARTIFACT_BINDING",
        message: "Coverage obligation references an orphan requirement analysis artifact",
      };
    }
    const analysis = ctx.relatedOfType("requirement-analysis").find((candidate) => candidate.record.id === analysisArtifactId);
    const statements = analysis?.value?.statements;
    if (!Array.isArray(statements)
      || statements.filter((statement) => isRecord(statement) && statement.requirementId === requirementId).length !== 1) {
      return {
        code: "ARTIFACT_BINDING",
        message: "Coverage obligation references an orphan or ambiguous requirement",
      };
    }
    return undefined;
  },
};

/** Rule: `test-plan` — stage-agnostic (no `ctx.stage` branch). On WRITE the shared equality check
 *  passes by construction because `withDerivedTestPlanApproval` (kept in the write flow) has already
 *  injected `approvalDecision = derivedDecision`; on READ it is the real persisted-equals-derived
 *  enforcement. The write-only forbid-self-asserted-field, unsafe-auto-approval guard, and
 *  registered-authority recheck stay in `withDerivedTestPlanApproval` / `assertTestPlanPolicy` (they
 *  are input-shape concerns handled before the rule, or provably-dead second-call branches). */
const testPlanRule: SemanticRule = {
  type: "test-plan",
  appliesTo: { write: true, read: true },
  async: false,
  evaluate(ctx) {
    const environments = ctx.relatedOfType("environment-profile");
    const profile = environments.length === 1 ? environments[0] : undefined;
    const classificationValue = profile?.value?.classification;
    const classification = typeof classificationValue === "string" ? classificationValue : undefined;
    if (classification === undefined) {
      return { code: "ARTIFACT_BINDING", message: "Test plan requires one authoritative environment profile" };
    }
    let decision: ApprovalDecision;
    try {
      decision = deriveTestPlanApproval({
        plan: ctx.value,
        requirementAnalyses: ctx.relatedOfType("requirement-analysis").flatMap((candidate) => (candidate.value ? [candidate.value] : [])),
        environment: { classification } as ApprovalEnvironment,
      });
    } catch (error) {
      return {
        code: "ARTIFACT_BINDING",
        message: error instanceof Error ? error.message : "Test plan approval derivation failed",
      };
    }
    if (JSON.stringify(ctx.value.approvalDecision) !== JSON.stringify(decision)) {
      return {
        code: "ARTIFACT_BINDING",
        message: "Persisted test plan approval decision does not equal the derived decision",
      };
    }
    return undefined;
  },
};

/** Rule: `test-result` — carries per-path drift (both message AND logic). WRITE splits the check into
 *  four distinct messages and adds a write-only attempt-uniqueness check plus a strict relationship
 *  binding on the matched case; READ folds the ordered-steps + aggregate-status checks into one message
 *  and drops the relationship binding (the attempt-uniqueness check is the read path's SEPARATE
 *  AMBIGUOUS_ATTEMPT loop, which is left in `inspectWorkspaceState` and is NOT part of this rule).
 *  Faithful to write `assertSemanticReferences` test-result branch and read `inspectWorkspaceState`
 *  inline test-result branch. */
const testResultRule: SemanticRule = {
  type: "test-result",
  appliesTo: { write: true, read: true },
  async: false,
  evaluate(ctx) {
    const value = ctx.value;
    const matches = ctx.relatedOfType("test-case").filter((candidate) =>
      candidate.value?.testCaseId === value.testCaseId
      && candidate.value?.revisionId === value.testCaseRevisionId
      && candidate.value?.instanceId === value.testCaseInstanceId);
    const testCase = matches.length === 1 ? matches[0] : undefined;
    if (ctx.stage === "write") {
      if (!testCase || ctx.relationships.filter((id) => id === testCase.record.id).length !== 1
        || ctx.relationships.filter((id) => ctx.registeredRecord(id, "test-case") !== undefined).length !== 1) {
        return { code: "ARTIFACT_BINDING", message: "Test result references an unregistered or ambiguous test case revision and instance" };
      }
    } else if (!testCase) {
      return { code: "ARTIFACT_BINDING", message: "Test result must reference exactly one registered test case revision and instance" };
    }
    const matchedCase = matches[0]!;
    const plan = ctx.relatedOfType("test-plan").find((candidate) => matchedCase.record.relationships.includes(candidate.record.id));
    const planCases = array(plan?.value?.testCases);
    const planCase = planCases.find((candidate) => isRecord(candidate) && candidate.testCaseId === value.testCaseId);
    const execution = isRecord(planCase) && isRecord(planCase.browserExecution) ? planCase.browserExecution : undefined;
    const browserDsl = execution && isRecord(execution.browserDsl) ? execution.browserDsl : undefined;
    const canonicalSteps = Array.isArray(browserDsl?.steps) ? browserDsl.steps : (Array.isArray(matchedCase.value?.steps) ? matchedCase.value.steps : []);
    const resultSteps = Array.isArray(value.steps) ? value.steps : [];
    const canonicalIds = canonicalSteps.map((step) => isRecord(step) ? step.id : undefined);
    const resultIds = resultSteps.map((step) => isRecord(step) ? step.stepId : undefined);
    const precedence = ["BLOCKED", "INCONCLUSIVE", "FAILED", "NOT_RUN", "PASSED"];
    const aggregate = precedence.find((status) => resultSteps.some((step) => isRecord(step) && step.status === status)) ?? "NOT_RUN";
    const stepsMismatch = canonicalIds.length !== resultIds.length || canonicalIds.some((id, index) => id !== resultIds[index]);
    if (ctx.stage === "write") {
      if (stepsMismatch) {
        return { code: "ARTIFACT_BINDING", message: "Test result must contain the exact ordered canonical test case steps" };
      }
      if (value.status !== aggregate) {
        return { code: "ARTIFACT_BINDING", message: "Test result aggregate status is not derived from its step results" };
      }
      if ((value.status === "PASSED") !== (value.failureClassification === "NONE")) {
        return { code: "ARTIFACT_BINDING", message: "Test result failure classification is incoherent with aggregate status" };
      }
      if (ctx.relatedOfType("test-result").some((candidate) => candidate.value?.attemptId === value.attemptId)) {
        return { code: "ARTIFACT_BINDING", message: "Test result attempt ID is already registered and would be ambiguous" };
      }
    } else {
      if (stepsMismatch || aggregate !== value.status) {
        return { code: "ARTIFACT_BINDING", message: "Test result must be derived from the exact ordered canonical steps and aggregate status" };
      }
      if ((value.status === "PASSED") !== (value.failureClassification === "NONE")) {
        return { code: "ARTIFACT_BINDING", message: "Test result failure classification is incoherent with aggregate status" };
      }
    }
    return undefined;
  },
};

/** Rule: `approval-decision` — carries logic drift. WRITE additionally requires the bound plan to be a
 *  pending human-review plan (`approvalPolicy.mode === "human-review"` + `approvalDecision.approved ===
 *  false`) and additionally requires exactly one test-plan relationship; READ has neither extra check
 *  and resolves the plan from the cascade-sensitive valid pool. Faithful to write
 *  `assertSemanticReferences` approval-decision branch and read inline approval-decision branch. */
const approvalDecisionRule: SemanticRule = {
  type: "approval-decision",
  appliesTo: { write: true, read: true },
  async: false,
  evaluate(ctx) {
    const value = ctx.value;
    if (ctx.stage === "write") {
      const plan = ctx.registeredRecord(typeof value.planArtifactId === "string" ? value.planArtifactId : "", "test-plan");
      if (!plan || plan.sha256 !== value.planSha256 || ctx.relationships.filter((id) => id === plan.id).length !== 1
        || ctx.relationships.filter((id) => ctx.registeredRecord(id, "test-plan") !== undefined).length !== 1) {
        return { code: "ARTIFACT_BINDING", message: "Human approval must bind one exact immutable test plan" };
      }
      const planValue = ctx.relatedOfType("test-plan").find((candidate) => candidate.record.id === plan.id)?.value;
      if (!isRecord(planValue?.approvalPolicy) || planValue.approvalPolicy.mode !== "human-review"
        || !isRecord(planValue.approvalDecision) || planValue.approvalDecision.approved !== false) {
        return { code: "ARTIFACT_BINDING", message: "Human approval requires a pending human-review test plan" };
      }
    } else {
      const plans = ctx.relatedOfType("test-plan").filter((candidate) => candidate.record.id === value.planArtifactId && candidate.record.sha256 === value.planSha256);
      if (plans.length !== 1 || ctx.relationships.filter((id) => id === plans[0]?.record.id).length !== 1) {
        return { code: "ARTIFACT_BINDING", message: "Human approval must bind one exact immutable test plan" };
      }
    }
    return undefined;
  },
};

/** Rule: `test-step-result` — message drift only. WRITE splits into two messages (unregistered/ambiguous
 *  attempt, then unregistered step); READ folds both into one combined message. Shared identity/step
 *  logic. Faithful to write `assertSemanticReferences` test-step-result branch and read inline branch. */
const testStepResultRule: SemanticRule = {
  type: "test-step-result",
  appliesTo: { write: true, read: true },
  async: false,
  evaluate(ctx) {
    const value = ctx.value;
    const matchingAttempts = ctx.relatedOfType("test-result").filter((candidate) => candidate.value?.attemptId === value.attemptId);
    const result = matchingAttempts.length === 1 ? matchingAttempts[0]?.value : undefined;
    const matchingCases = result
      ? ctx.relatedOfType("test-case").filter((candidate) =>
        candidate.value?.testCaseId === result.testCaseId
        && candidate.value?.revisionId === result.testCaseRevisionId)
      : [];
    const steps = matchingCases.length === 1 ? matchingCases[0]?.value?.steps : undefined;
    if (ctx.stage === "write") {
      if (matchingAttempts.length !== 1) {
        return { code: "ARTIFACT_BINDING", message: "Test step result references an unregistered or ambiguous attempt" };
      }
      if (!Array.isArray(steps) || !steps.some((step) => isRecord(step) && step.id === value.stepId)) {
        return { code: "ARTIFACT_BINDING", message: "Test step result references an unregistered step" };
      }
    } else if (
      matchingAttempts.length !== 1
      || matchingCases.length !== 1
      || !Array.isArray(steps)
      || !steps.some((step) => isRecord(step) && step.id === value.stepId)
    ) {
      return { code: "ARTIFACT_BINDING", message: "Test step result must reference one registered attempt and test case step" };
    }
    return undefined;
  },
};

/** Rule: `incident` — message drift only. WRITE splits into two messages (kind derivation, then
 *  evidence/gap presence); READ folds both into one combined message. Shared attempt/kind/evidence
 *  logic. Faithful to write `assertSemanticReferences` incident branch and read inline incident branch. */
const incidentRule: SemanticRule = {
  type: "incident",
  appliesTo: { write: true, read: true },
  async: false,
  evaluate(ctx) {
    const value = ctx.value;
    const attempt = ctx.relatedOfType("test-result").find((candidate) => candidate.value?.attemptId === value.attemptId)?.value;
    const expectedKind = attempt?.failureClassification === "TEST_DEFECT" ? "TEST_INCIDENT"
      : attempt?.failureClassification === "ENVIRONMENT_DEFECT" ? "ENVIRONMENT_INCIDENT"
        : attempt?.failureClassification === "UNDETERMINED" ? "INVESTIGATION_FINDING" : undefined;
    const validEvidence = Array.isArray(value.evidenceIds) && value.evidenceIds.length > 0 && value.evidenceIds.every((id) => ctx.relatedOfType("evidence").some((candidate) => candidate.value?.evidenceId === id && candidate.value?.attemptId === value.attemptId && candidate.value?.runId === ctx.runId));
    const validGap = Array.isArray(value.evidenceGapIds) && value.evidenceGapIds.length > 0 && value.evidenceGapIds.every((id) => ctx.relatedOfType("evidence-gap").some((candidate) => candidate.value?.evidenceGapId === id && candidate.value?.attemptId === value.attemptId && candidate.value?.runId === ctx.runId));
    if (ctx.stage === "write") {
      if (!attempt || attempt.status === "PASSED" || value.kind !== expectedKind) {
        return { code: "ARTIFACT_BINDING", message: "Incident kind must derive from a registered non-product attempt" };
      }
      if (!validEvidence && !validGap) {
        return { code: "ARTIFACT_BINDING", message: "Incident requires registered evidence or an evidence gap for its exact attempt" };
      }
    } else if (!attempt || attempt.status === "PASSED" || value.kind !== expectedKind || (!validEvidence && !validGap)) {
      return { code: "ARTIFACT_BINDING", message: "Incident must bind its exact non-product attempt to registered evidence or an evidence gap" };
    }
    return undefined;
  },
};

/** Rule: `release-gate` — message drift only; the write/read POPULATION difference (cascade) is carried
 *  by `ctx.related()` (WRITE = on-disk registered set, always valid; READ = cascade-sensitive valid
 *  pool). Both stages recompute the gate over all non-gate/non-report artifacts and compare it to the
 *  persisted snapshot. Faithful to write `assertSemanticReferences` release-gate branch and read inline
 *  release-gate branch. */
const releaseGateRule: SemanticRule = {
  type: "release-gate",
  appliesTo: { write: true, read: true },
  async: false,
  evaluate(ctx) {
    const value = ctx.value;
    const derived = deriveReleaseGateFromWorkspaceArtifacts(ctx.related()
      .filter((candidate) => candidate.record.type !== "release-gate" && candidate.record.type !== "qa-execution-report" && candidate.value !== undefined)
      .map((candidate) => ({ record: { id: candidate.record.id, sha256: candidate.record.sha256, type: candidate.record.type, provenance: candidate.record.provenance }, value: candidate.value as Record<string, unknown> })));
    if (value.runId !== ctx.runId
      || JSON.stringify(value.sourceArtifacts) !== JSON.stringify(derived.sourceArtifacts)
      || JSON.stringify(value.ruleInputs) !== JSON.stringify(derived.ruleInputs)
      || JSON.stringify(value.verdicts) !== JSON.stringify(derived.verdicts)
      || value.recommendation !== derived.recommendation) {
      return {
        code: "ARTIFACT_BINDING",
        message: ctx.stage === "write" ? "Release gate must equal the complete workspace-derived fact snapshot" : "Release gate is not derived from the complete manifest facts",
      };
    }
    return undefined;
  },
};

/** Rule: `qa-execution-report` — carries message AND logic drift. WRITE additionally requires the
 *  report's top-level `releaseRecommendation` to equal its own embedded `releaseGate.recommendation`;
 *  READ omits that clause. Both embed the single registered release gate. Faithful to write
 *  `assertSemanticReferences` qa-execution-report branch and read inline qa-execution-report branch. */
const qaExecutionReportRule: SemanticRule = {
  type: "qa-execution-report",
  appliesTo: { write: true, read: true },
  async: false,
  evaluate(ctx) {
    const value = ctx.value;
    const gates = ctx.relatedOfType("release-gate");
    if (ctx.stage === "write") {
      const gate = gates[0]?.value;
      const expectedGate = gate === undefined ? undefined : { sourceArtifacts: gate.sourceArtifacts, recommendation: gate.recommendation, ruleInputs: gate.ruleInputs, verdicts: gate.verdicts };
      if (gates.length !== 1 || !isRecord(value.releaseGate) || value.releaseRecommendation !== value.releaseGate.recommendation
        || gate?.recommendation !== value.releaseRecommendation || canonicalJson(value.releaseGate) !== canonicalJson(expectedGate)) {
        return { code: "ARTIFACT_BINDING", message: "QA report must reference the single registered deterministic release gate" };
      }
    } else {
      const gate = gates.length === 1 ? gates[0]?.value : undefined;
      const expectedGate = gate === undefined ? undefined : { sourceArtifacts: gate.sourceArtifacts, recommendation: gate.recommendation, ruleInputs: gate.ruleInputs, verdicts: gate.verdicts };
      if (!gate || !isRecord(value.releaseGate) || value.releaseRecommendation !== gate.recommendation || canonicalJson(value.releaseGate) !== canonicalJson(expectedGate)) {
        return { code: "ARTIFACT_BINDING", message: "QA report must embed the complete registered release gate" };
      }
    }
    return undefined;
  },
};

/** Rule: `test-data-manifest` — no drift; the write and read checks and messages are identical (unique
 *  resource ids, every `ownerRunId === ctx.runId`). No `ctx.stage` branch. Faithful to write
 *  `assertSemanticReferences` test-data-manifest branch and read inline test-data-manifest branch. */
const testDataManifestRule: SemanticRule = {
  type: "test-data-manifest",
  appliesTo: { write: true, read: true },
  async: false,
  evaluate(ctx) {
    const resources = ctx.value.resources;
    if (!uniqueResourceIds(resources) || !resources.every((resource) => resource.ownerRunId === ctx.runId)) {
      return { code: "ARTIFACT_BINDING", message: "Test data resource owner run does not match this workspace" };
    }
    return undefined;
  },
};

/** Rule: `exploration-charter` — carries message AND logic drift. WRITE checks that NO charter is
 *  already registered (`relatedOfType("exploration-charter").length > 0`, since the new charter is not
 *  yet in the pool); READ checks that EXACTLY ONE valid charter exists (the persisted one is in the
 *  pool). Both require the sole environment-profile relationship. Faithful to write
 *  `assertSemanticReferences` exploration-charter branch and read inline exploration-charter branch. */
const explorationCharterRule: SemanticRule = {
  type: "exploration-charter",
  appliesTo: { write: true, read: true },
  async: false,
  evaluate(ctx) {
    const value = ctx.value;
    const environment = ctx.relatedOfType("environment-profile")[0];
    if (ctx.stage === "write") {
      if (value.runId !== ctx.runId || ctx.relatedOfType("exploration-charter").length > 0 || !environment
        || ctx.relationships.length !== 1 || ctx.relationships[0] !== environment.record.id) {
        return { code: "ARTIFACT_BINDING", message: "An exploratory run requires exactly one runtime-bound charter" };
      }
    } else if (value.runId !== ctx.runId || ctx.relatedOfType("exploration-charter").length !== 1 || !environment
      || ctx.relationships.length !== 1 || ctx.relationships[0] !== environment.record.id) {
      return { code: "ARTIFACT_BINDING", message: "Exploration charter must be the sole run-bound charter linked to the environment" };
    }
    return undefined;
  },
};

/** The shared table. Task 14 migrated the three overlapping planning types; Task 15a adds the eight
 *  synchronous "both-path" types below. Every remaining type stays on its legacy write branch / read
 *  inline-chain branch (the adapters fall through). */
export const semanticRules: Partial<Record<ArtifactType, SemanticRule>> = {
  "requirement-analysis": requirementAnalysisRule,
  "coverage-obligation": coverageObligationRule,
  "test-plan": testPlanRule,
  "test-result": testResultRule,
  "approval-decision": approvalDecisionRule,
  "test-step-result": testStepResultRule,
  "incident": incidentRule,
  "release-gate": releaseGateRule,
  "qa-execution-report": qaExecutionReportRule,
  "test-data-manifest": testDataManifestRule,
  "exploration-charter": explorationCharterRule,
};

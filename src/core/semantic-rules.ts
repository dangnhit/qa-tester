import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArtifactType, RunStatus } from "../contracts/types.js";
import { validateArtifact } from "../contracts/validator.js";
import { createBugFingerprint, createRunScopedBugId } from "../defects/fingerprint.js";
import { evaluateReproduction } from "../defects/reproduction.js";
import { deriveTestPlanApproval, type ApprovalDecision, type ApprovalEnvironment } from "../planning/approval.js";
import { assertRequirementAuthorities } from "../planning/authority.js";
import { regressionCaseFromCanonical } from "../regression/change-scope.js";
import { selectRegressionCases } from "../regression/selector.js";
import { deriveReleaseGateFromWorkspaceArtifacts } from "../reporting/release-gate.js";
import { deriveRegressionOutcome, deriveRetestVerdict, sourceScenarioId } from "../retest/verdict.js";
import { indexByAttemptId, indexByKey, indexByTestCaseIdentity, type TestCaseIdentity } from "./artifact-index.js";
import { evidenceAttemptId, evidenceSubject, terminalStatuses, type ArtifactRecord, type Manifest } from "./artifact-record.js";
import type { ArtifactProfileName } from "./artifact-profiles.js";
import { sha256, sha256Text } from "./checksum.js";
import { assertRealpathWithin } from "./fs.js";
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

/** Index selectors shared by the attempt/test-case lookups below (Task 30). They exist so every rule
 *  keys its index the same way the `===` predicate it replaced compared, and so the `test-case`
 *  payload's own field names (`revisionId` / `instanceId`) are reconciled with the
 *  `testCaseRevisionId` / `testCaseInstanceId` spelling every consumer uses in exactly one place. */
const attemptIdOf = (candidate: RelatedArtifact): unknown => candidate.value?.attemptId;
const testCaseIdentityOf = (candidate: RelatedArtifact): TestCaseIdentity =>
  ({ testCaseId: candidate.value?.testCaseId, testCaseRevisionId: candidate.value?.revisionId, testCaseInstanceId: candidate.value?.instanceId });

/** Moved VERBATIM from `run-workspace.ts` (retest reproduction-occurrence comparison). */
function sameStringOccurrences(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

/** Moved VERBATIM from `run-workspace.ts` (cleanup resource-ownership comparison). */
function sameResourceIdentity(left: unknown, right: unknown): boolean {
  return isRecord(left) && isRecord(right)
    && left.id === right.id && left.ownerRunId === right.ownerRunId && left.cleanupAction === right.cleanupAction;
}

/** Reopens source evidence by explicit ID and checksum, making a cleanup artifact independently auditable.
 *  Moved VERBATIM from `run-workspace.ts`; the `cleanup-run` rule invokes it with `ctx.path`. */
async function assertCleanupProvenance(cleanupPath: string, value: Record<string, unknown>): Promise<void> {
  const sourceRunId = value.sourceRunId;
  const artifactId = value.sourceTestDataManifestArtifactId;
  const expectedSha = value.sourceTestDataManifestSha256;
  const snapshot = value.sourceTestDataManifest;
  const cleanupResources = value.resources;
  if (typeof sourceRunId !== "string" || typeof artifactId !== "string" || typeof expectedSha !== "string" || !isRecord(snapshot) || !Array.isArray(cleanupResources)) throw new Error("Cleanup provenance is incomplete");
  const root = dirname(dirname(cleanupPath));
  const sourcePath = await assertRealpathWithin(root, join("qa-results", sourceRunId));
  const sourceMetadata = JSON.parse(await readFile(await assertRealpathWithin(sourcePath, "run-metadata.json"), "utf8")) as unknown;
  if (!validateArtifact("run-metadata", sourceMetadata).valid || !isRecord(sourceMetadata) || !terminalStatuses.has(sourceMetadata.status as RunStatus)) throw new Error("Cleanup source run must be immutable and terminal");
  const sourceManifest = JSON.parse(await readFile(await assertRealpathWithin(sourcePath, "artifact-manifest.json"), "utf8")) as Manifest;
  if (!validateArtifact("artifact-manifest", sourceManifest).valid || sourceManifest.runId !== sourceRunId) throw new Error("Cleanup source manifest is invalid");
  const sourceRecord = sourceManifest.artifacts.find((record) => record.id === artifactId && record.type === "test-data-manifest");
  if (!sourceRecord || sourceRecord.sha256 !== expectedSha) throw new Error("Cleanup source test-data artifact ID or checksum is invalid");
  const sourceArtifactPath = await assertRealpathWithin(sourcePath, sourceRecord.relativePath);
  if (await sha256(sourceArtifactPath) !== expectedSha) throw new Error("Cleanup source test-data artifact checksum no longer matches");
  const sourceValue = JSON.parse(await readFile(sourceArtifactPath, "utf8")) as unknown;
  if (!validateArtifact("test-data-manifest", sourceValue).valid || !isRecord(sourceValue) || sourceValue.runId !== sourceRunId) throw new Error("Cleanup source test-data artifact is invalid");
  if (JSON.stringify(sourceValue) !== JSON.stringify(snapshot)) throw new Error("Cleanup source snapshot does not equal the immutable source artifact");
  const sourceResources = sourceValue.resources;
  if (!uniqueResourceIds(sourceResources) || !uniqueResourceIds(cleanupResources) || sourceResources.length !== cleanupResources.length || !sourceResources.every((resource) => cleanupResources.some((candidate) => sameResourceIdentity(resource, candidate)))) throw new Error("Cleanup resources do not exactly match source resource ownership");
}

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
    // `.get` returns the FULL bucket in pool order, so this stays a `.filter()` — the `length === 1`
    // ambiguity decision below is the reason the index maps to arrays rather than single artifacts.
    const matches = indexByTestCaseIdentity(ctx.relatedOfType("test-case"), testCaseIdentityOf)
      .get({ testCaseId: value.testCaseId, testCaseRevisionId: value.testCaseRevisionId, testCaseInstanceId: value.testCaseInstanceId });
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
      if (indexByAttemptId(ctx.relatedOfType("test-result"), attemptIdOf).get(value.attemptId).length > 0) {
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

/** Rule: `test-result-batch` — the lane-2 (ADR-0010) counterpart of `testResultRule`: one artifact per
 *  Runtime-Observed Execution carrying many entries. Unlike the migrated types above, this type is NEW,
 *  so it has no pre-Phase-2a write/read chains to reproduce and therefore NO sanctioned drift: the rule
 *  is deliberately stage-agnostic (no `ctx.stage` branch), and both paths surface the same message —
 *  write throws it as ARTIFACT_BINDING, read soft-invalidates as INVALID_REFERENCE.
 *
 *  It enforces, in order: unique `entryId` within the batch; each entry binds to exactly one registered
 *  `test-case` on the same identity triple `testResultRule` uses; the same PASSED <-> NONE coherence
 *  check `testResultRule` applies to an attempt; evidence attached ONLY to failing entries (the plan's
 *  "evidence attached only for failing cases", made checkable); and — since Phase 7 — every declared
 *  `evidenceArtifactIds` entry resolving to a registered `evidence` record that the batch ALSO declares
 *  as a relationship and whose `subject` is this batch's own `{kind:"observed-execution", executionId}`.
 *
 *  Two checks `testResultRule` applies are deliberately ABSENT. The ordered-canonical-steps/aggregate
 *  derivation is not applicable: an observed execution's steps come from an external suite, not from the
 *  approved Test DSL, so there is no canonical step list to equal. And there is no relationship binding
 *  requirement on the matched test cases — a batch covers many cases and Phase 7 owns what it declares.
 *
 *  Schema 3.0.0's per-entry `executionSurface` and `viewport` add NO check here, which is a decision
 *  rather than an omission. Their structure — a surface from the obligation enum, a viewport required
 *  on `browser` and forbidden off it, an engine on the same conditional — is fully expressed by the
 *  schema, and every cross-artifact check they suggest would be the very defect the fields exist to
 *  remove. An entry's surface cannot be checked against its bound test case's, because a test case
 *  DECLARES no surface and deliberately never will (`CoverageAttempt#executionSurface`): adding one to
 *  compare against would recreate the drift surface, and a test case is browser-shaped in its coverage
 *  block regardless, so an api entry binding one is coherent, not contradictory — that is exactly the
 *  case the coverage readers must be free to decline. Nor may a browser entry's reported viewport be
 *  required to equal the test case's declared one: the entry reports what an external runner rendered
 *  at, so a disagreement is a FACT, and the correct consequence is the obligation going uncredited in
 *  the readers, not the observation being rejected here. Rejecting it would put a declaration back in
 *  charge of whether an observation is admissible. `manual` is refused, but not by this rule: the
 *  entry's own `executionSurface` enum (shared/schemas/test-result-batch.schema.json) is a strict
 *  SUBSET of the obligation's, missing exactly `manual` — a machine-written entry has no spec tree to
 *  hash for a human's manual evaluation, so the schema rejects it outright before this rule ever runs.
 *  A rule check here would be redundant with that boundary, not an alternative to it.
 *  Evidence EXISTENCE keys on `ctx.registeredRecord` (manifest existence, stable on both paths) rather
 *  than the cascade-sensitive valid pool, matching `bugReportRule`'s evidence-provenance check; the
 *  subject comparison added in Phase 7 necessarily reads the valid pool, because only it carries values.
 *
 *  THE REVERSE DIRECTION IS RULED OUT, NOT LEFT UNDONE. This rule closes batch -> evidence. Nothing
 *  anywhere requires the converse — that every registered `observed-execution` evidence item be claimed
 *  by some batch entry. That check cannot live on `evidence` (registration order is evidence first, then
 *  the batch that cites it; the reverse is circular, since clause 3 above must resolve the evidence),
 *  which leaves `inspectWorkspaceState`, where every artifact is present at once. It must not live there
 *  either, for two independent reasons.
 *
 *  It would be WRONG. `readRegisteredArtifacts()` THROWS on the first diagnostic, and the read path runs
 *  continuously during a run — on every `open()` and every read — not once at the end. Between
 *  registering the evidence and registering the batch, an unclaimed observed-execution evidence item is
 *  the CORRECT state of a healthy workspace; a "must be claimed" rule would make the workspace
 *  unreadable in exactly that window. Since Task 37 a run may legitimately PAUSE there
 *  (AWAITING_HUMAN_INPUT), and a run may be ABORTED there — leaving a terminal, immutable workspace that
 *  could never be read again. That converts a truthful, checksummed observation into permanent
 *  corruption.
 *
 *  And it would be POINTLESS, because an unclaimed observed-execution evidence item is inert: it buys
 *  nothing anywhere. Coverage never reads `evidence` at all (`evaluateCoverage` /
 *  `evaluate-workspace-coverage` credit obligations from results, attestations and batches), and
 *  `deriveReleaseGateFromWorkspaceArtifacts` reads only `evidence-gap`, so it moves neither credit nor
 *  the gate. `generateQaReport` reads exactly two things from an evidence value: `provenance.build`,
 *  which a `runner-report` provenance does not have by construction (it is not a field of that branch),
 *  so it contributes `undefined` and is skipped; and `telemetryFindings`, which are reported against the
 *  evidence ARTIFACT ID with no `attemptId`, i.e. naming only themselves. `bugReportRule` cannot cite it
 *  in `evidenceIds` either — that clause requires `evidenceAttemptId(evidence)` to be one of the bug's
 *  source attempts, and an observed-execution subject yields `undefined`. And `evidenceRule` plus the
 *  two read blocks already assert positively that such an item claims NO test-result relationship, so it
 *  cannot impersonate an attempt-bound observation. An unclaimed one is a recorded fact that substantiates
 *  no claim — which is exactly what an Evidence Item is allowed to be.
 *
 *  This rule does not touch `commitSha` or `specTreeSha256` either, though both are `required` by the
 *  schema with hex patterns: the git anchor ADR-0010 rests coverage credit on ("a human merged the spec
 *  and a hash proves it") is recorded here but NOT verified here, and cannot be — semantic rules are pure
 *  over registered artifacts, and confirming a commit is merged and a spec tree hash is current needs
 *  git, which this layer has no access to. Verifying the anchor before it is recorded is the producer's
 *  obligation (`qa-skill execute playwright`, plan line 95), not this rule's. */
const testResultBatchRule: SemanticRule = {
  type: "test-result-batch",
  appliesTo: { write: true, read: true },
  async: false,
  evaluate(ctx) {
    const entries = array(ctx.value.entries).filter(isRecord);
    const entryIds = entries.map((entry) => entry.entryId);
    if (new Set(entryIds).size !== entryIds.length) {
      return { code: "ARTIFACT_BINDING", message: "Test result batch entry IDs must be unique within the batch" };
    }
    // Hoisted out of the loop below: the related-artifact pool is fixed for the duration of one rule
    // invocation (read: the cascade-sensitive valid set for this fixpoint pass; write: the pre-read
    // manifest snapshot), so re-querying it per entry would repeat identical filter/map allocations
    // for what is, by design, the one artifact type holding many entries. Indexing that hoisted pool
    // once (Task 30) is what turns the per-entry rescan into a lookup: this is the only call site in
    // this file where the index changes complexity class (O(entries x cases) -> O(cases + entries)).
    const cases = indexByTestCaseIdentity(ctx.relatedOfType("test-case"), testCaseIdentityOf);
    // Hoisted for the same reason as `cases`, and keyed on the manifest RECORD id because that is what
    // an entry's `evidenceArtifactIds` holds. Unlike the existence check below — which stays on
    // `ctx.registeredRecord` — the subject comparison needs the evidence VALUE, and only the related
    // pool carries values. Evidence BINARIES share the `evidence` type and have no value; they are
    // indexed here alongside descriptors and simply fail the subject read, which is correct: a batch
    // may cite the descriptor that states what the evidence is about, never the raw bytes.
    const evidenceById = indexByKey(ctx.relatedOfType("evidence"), (candidate) => candidate.record.id);
    for (const entry of entries) {
      const matches = cases.get({ testCaseId: entry.testCaseId, testCaseRevisionId: entry.testCaseRevisionId, testCaseInstanceId: entry.testCaseInstanceId });
      if (matches.length !== 1) {
        return { code: "ARTIFACT_BINDING", message: "Test result batch entry references an orphan or ambiguous test case revision and instance" };
      }
      if ((entry.status === "PASSED") !== (entry.failureClassification === "NONE")) {
        return { code: "ARTIFACT_BINDING", message: "Test result batch entry failure classification is incoherent with its status" };
      }
      if (entry.evidenceArtifactIds === undefined) continue;
      if (entry.status === "PASSED") {
        return { code: "ARTIFACT_BINDING", message: "Passed test result batch entry must not declare evidence artifacts" };
      }
      // The FORWARD half of the batch<->evidence linkage, closed by Phase 7 (this task). Three clauses,
      // each with its own message so that deleting one cannot stay green on another's:
      //
      //   1. the id names a registered `evidence` artifact. Unchanged, and still keyed on
      //      `ctx.registeredRecord` (manifest existence, stable on both paths) rather than the
      //      cascade-sensitive valid pool — same choice as `bugReportRule`'s evidence-provenance check.
      //   2. the BATCH declares that id as a relationship. This is the design decision the earlier
      //      comment deferred to this phase: an entry's `evidenceArtifactIds` is a payload field, and a
      //      payload field alone reaches nothing the relationship graph can be audited against, so the
      //      producer must now say it twice — in the entry and in the batch's relationships. Exactly the
      //      shape `bugReportRule` already requires of `provenance.evidenceArtifactIds`.
      //   3. the resolved evidence is ABOUT this batch's own Runtime-Observed Execution: its `subject`
      //      is `{kind:"observed-execution", executionId}` and that `executionId` equals the batch's.
      //      An ATTEMPT subject fails here, deliberately — an attempt-bound evidence item is lane 1's,
      //      substantiating one `test-result` (CONTEXT.md:363), and a batch citing it would be claiming
      //      substantiation that was never about this execution.
      //
      // Clause 3 needs the evidence VALUE, which a manifest record does not carry, so it reads the
      // hoisted related pool. On READ that pool is cascade-sensitive: an evidence item invalidated
      // earlier in the pass resolves to no subject and the batch is invalidated with it, which is the
      // right consequence — a batch whose substantiation is no longer readable may not keep asserting
      // it. On WRITE the pool is the on-disk registered set, where every entry is valid by construction.
      //
      // The REVERSE direction — an `observed-execution` evidence item that NO batch ever claims — stays
      // unenforced, and that is a ruling, not the leftover half of this one. See the rule's block
      // comment above for why such an item is inert and why enforcing it would be actively harmful.
      const declaredEvidenceIds = array(entry.evidenceArtifactIds);
      if (!declaredEvidenceIds.every((id): id is string => typeof id === "string" && ctx.registeredRecord(id, "evidence") !== undefined)) {
        return { code: "ARTIFACT_BINDING", message: "Test result batch entry references unregistered evidence" };
      }
      if (!declaredEvidenceIds.every((id) => ctx.relationships.includes(id))) {
        return { code: "ARTIFACT_BINDING", message: "Test result batch entry evidence must be declared as a relationship of the batch" };
      }
      if (!declaredEvidenceIds.every((id) => {
        const subject = evidenceSubject(evidenceById.get(id)[0]?.value);
        return subject?.kind === "observed-execution" && subject.executionId === ctx.value.executionId;
      })) {
        return { code: "ARTIFACT_BINDING", message: "Test result batch entry evidence must be about this batch's own observed execution" };
      }
    }
    return undefined;
  },
};

/** Rule: `human-attestation` — like `testResultBatchRule`, a type authored directly onto this table,
 *  so it has no pre-Phase-2a write/read chains to reproduce and therefore NO sanctioned drift: it is
 *  deliberately stage-agnostic (no `ctx.stage` branch) and both paths surface the same message — write
 *  throws it as ARTIFACT_BINDING, read soft-invalidates as INVALID_REFERENCE.
 *
 *  It enforces the two bindings that make an attestation mean anything. First, the attestation names
 *  ONE exact immutable `coverage-obligation`: among the coverage-obligation artifacts the attestation
 *  itself DECLARES AS A RELATIONSHIP, exactly one carries its `obligationId`, that obligation is the
 *  attestation's sole declared coverage-obligation relationship, and the obligation's manifest checksum
 *  equals the declared `obligationSha256`. The `obligationId` match is scoped to the declared
 *  relationship (not to every registered `coverage-obligation` in the run) deliberately: `obligationId`
 *  uniqueness is NOT otherwise enforced (`coverageObligationRule` never checks it, and the CLI-shipped
 *  skeleton in `src/cli/artifact-drafts.ts` uses a fixed placeholder ID), so an unrelated later
 *  obligation that happens to share the ID must not retroactively invalidate an already-signed
 *  attestation it has nothing to do with. The relationship-count clauses below already pin the
 *  attestation to exactly one coverage-obligation relationship, so scoping the `obligationId` search to
 *  that same declared relationship loses no precision: the binding is still exact via relationship-id
 *  PLUS `obligationSha256`, and the `obligationId` match now only has to disambiguate within a set that
 *  the other clauses already cap at one. The checksum clause is the same device `approvalDecisionRule`
 *  uses for `planSha256` — it makes the claim auditable against the bytes the attester saw rather than
 *  against whatever the manifest resolves later, and it is what turns a rewritten obligation into an
 *  invalid attestation instead of a silently re-pointed one.
 *  Second, the attested `method` equals the obligation's declared `accessibilityMethod`: an
 *  attestation for an obligation naming a different method, or naming none (`null`), is a violation,
 *  because CONTEXT.md:438 makes a Human Attestation the satisfier of a specific manual method, not a
 *  free-floating claim.
 *
 *  This rule is what the coverage layer relies on and does not re-check: `evaluateCoverage` credits a
 *  manual Accessibility Obligation from a bound attestation (CONTEXT.md:438) without re-verifying the
 *  relationship, the checksum, or the method, because every clause below has already run on every
 *  artifact either reader can see. See `ResolvedCoverageObligation#humanAttested`.
 *
 *  Two things this rule deliberately does NOT check. There is no `value.runId !== ctx.runId` clause:
 *  BOTH paths already enforce that universally for any artifact carrying a `runId`
 *  (`assertArtifactBinding` on write, `inspectWorkspaceState`'s per-artifact loop on read), so a
 *  clause here would be unreachable — and a test naming it would pass for the universal check's
 *  reason, not this rule's. And nothing here says an attestation SATISFIES its obligation: that is
 *  the coverage layer's decision, made in `evaluateCoverage`. This rule only makes the artifact
 *  honest; what an honest artifact then buys is decided elsewhere. */
const humanAttestationRule: SemanticRule = {
  type: "human-attestation",
  appliesTo: { write: true, read: true },
  async: false,
  evaluate(ctx) {
    const value = ctx.value;
    // Scoped to the attestation's OWN declared relationships first (see the rule doc above): an
    // unrelated coverage-obligation elsewhere in the run that happens to share this `obligationId`
    // must not affect this lookup at all.
    const matches = ctx.relatedOfType("coverage-obligation")
      .filter((candidate) => ctx.relationships.includes(candidate.record.id))
      .filter((candidate) => candidate.value?.obligationId === value.obligationId);
    const obligation = matches.length === 1 ? matches[0] : undefined;
    if (!obligation
      || ctx.relationships.filter((id) => id === obligation.record.id).length !== 1
      || ctx.relationships.filter((id) => ctx.registeredRecord(id, "coverage-obligation") !== undefined).length !== 1
      || obligation.record.sha256 !== value.obligationSha256) {
      return { code: "ARTIFACT_BINDING", message: "Human attestation must bind one exact immutable coverage obligation" };
    }
    if (obligation.value?.accessibilityMethod !== value.method) {
      return { code: "ARTIFACT_BINDING", message: "Human attestation method must equal the accessibility method its obligation declares" };
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
    const matchingAttempts = indexByAttemptId(ctx.relatedOfType("test-result"), attemptIdOf).get(value.attemptId);
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
    // `.find()` took the FIRST match, which is `[0]` of the bucket because the bucket preserves pool order.
    const attempt = indexByAttemptId(ctx.relatedOfType("test-result"), attemptIdOf).get(value.attemptId)[0]?.value;
    const expectedKind = attempt?.failureClassification === "TEST_DEFECT" ? "TEST_INCIDENT"
      : attempt?.failureClassification === "ENVIRONMENT_DEFECT" ? "ENVIRONMENT_INCIDENT"
        : attempt?.failureClassification === "UNDETERMINED" ? "INVESTIGATION_FINDING" : undefined;
    // The attempt equality was one conjunct of each `.some(...)` below and is now carried by the bucket,
    // so the residual predicate keeps only the id and run-scope conjuncts. Evidence claims its attempt
    // inside its `subject` union (schema 2.0.0), hence `evidenceAttemptId` as that index's key.
    const evidenceForAttempt = indexByAttemptId(ctx.relatedOfType("evidence"), (candidate) => evidenceAttemptId(candidate.value)).get(value.attemptId);
    const gapsForAttempt = indexByAttemptId(ctx.relatedOfType("evidence-gap"), attemptIdOf).get(value.attemptId);
    const validEvidence = Array.isArray(value.evidenceIds) && value.evidenceIds.length > 0 && value.evidenceIds.every((id) => evidenceForAttempt.some((candidate) => candidate.value?.evidenceId === id && candidate.value?.runId === ctx.runId));
    const validGap = Array.isArray(value.evidenceGapIds) && value.evidenceGapIds.length > 0 && value.evidenceGapIds.every((id) => gapsForAttempt.some((candidate) => candidate.value?.evidenceGapId === id && candidate.value?.runId === ctx.runId));
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
      // The protected-environment LABEL (D12) is a deterministic pure function of the persisted
      // profile, so the persisted label must equal the re-derived one — a tampered label cannot lie.
      || value.protectedEnvironment !== derived.protectedEnvironment
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
      const expectedGate = gate === undefined ? undefined : { sourceArtifacts: gate.sourceArtifacts, recommendation: gate.recommendation, protectedEnvironment: gate.protectedEnvironment, ruleInputs: gate.ruleInputs, verdicts: gate.verdicts };
      if (gates.length !== 1 || !isRecord(value.releaseGate) || value.releaseRecommendation !== value.releaseGate.recommendation
        || gate?.recommendation !== value.releaseRecommendation || canonicalJson(value.releaseGate) !== canonicalJson(expectedGate)) {
        return { code: "ARTIFACT_BINDING", message: "QA report must reference the single registered deterministic release gate" };
      }
    } else {
      const gate = gates.length === 1 ? gates[0]?.value : undefined;
      const expectedGate = gate === undefined ? undefined : { sourceArtifacts: gate.sourceArtifacts, recommendation: gate.recommendation, protectedEnvironment: gate.protectedEnvironment, ruleInputs: gate.ruleInputs, verdicts: gate.verdicts };
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

/** Rule: `bug-report` — the heaviest, ASYNC (reopens each `possibleDuplicateSources` run via
 *  `ctx.openRun`). Massive per-path drift: WRITE derives+asserts each field with its own message
 *  (~10 distinct messages) and PROPAGATES a cross-run reopen error (uncaught); READ folds every check
 *  into one boolean with one combined message and SWALLOWS cross-run reopen errors (`catch → invalid`).
 *  Every cross-run view is `close()`d in a `finally`. Faithful to write `assertSemanticReferences`
 *  bug-report branch and read `inspectWorkspaceState` inline bug-report branch. */
const bugReportRule: SemanticRule = {
  type: "bug-report",
  appliesTo: { write: true, read: true },
  async: true,
  async evaluate(ctx) {
    const value = ctx.value;
    if (ctx.stage === "write") {
      const registeredValues = (type: ArtifactType): Record<string, unknown>[] =>
        ctx.relatedOfType(type).map((candidate) => candidate.value as Record<string, unknown>);
      const testResults = registeredValues("test-result");
      // One index serves all three attempt lookups in this branch. `registeredValues` maps the pool to
      // its payloads, and on the WRITE path every related artifact HAS a payload (`readRegisteredValues`
      // throws on any unreadable/invalid one and its length is asserted equal to the record count), so
      // keying on `result.attemptId` cannot fault on an absent value.
      const resultsByAttempt = indexByAttemptId(testResults, (result) => result.attemptId);
      const sourceAttemptIds = isRecord(value.provenance) && Array.isArray(value.provenance.sourceAttemptIds) ? value.provenance.sourceAttemptIds : [];
      const reproductionAttemptIds = isRecord(value.reproduction) && Array.isArray(value.reproduction.attemptIds) ? value.reproduction.attemptIds : [];
      if (reproductionAttemptIds.length === 0 || sourceAttemptIds.length === 0 || value.attemptId !== sourceAttemptIds[0]
        || sourceAttemptIds.length !== reproductionAttemptIds.length
        || !sourceAttemptIds.every((id, index) => id === reproductionAttemptIds[index])
        || !sourceAttemptIds.every((attemptId) => resultsByAttempt.get(attemptId).length === 1)) {
        return { code: "ARTIFACT_BINDING", message: "Bug report reproduction references unregistered or ambiguous attempts" };
      }
      const original = resultsByAttempt.get(value.attemptId)[0];
      if (original?.status !== "FAILED" || original.failureClassification !== "PRODUCT_DEFECT") {
        return { code: "ARTIFACT_BINDING", message: "Only FAILED PRODUCT_DEFECT attempts may create a bug report" };
      }
      const sourceAttempts = sourceAttemptIds.map((attemptId) => resultsByAttempt.get(attemptId)[0]);
      if (sourceAttempts.some((attempt) => !attempt)) return { code: "ARTIFACT_BINDING", message: "Bug report reproduction is incomplete" };
      const unsafeRerunReason = isRecord(value.reproduction) && typeof value.reproduction.unsafeRerunReason === "string" ? value.reproduction.unsafeRerunReason : undefined;
      let derivedReproduction: ReturnType<typeof evaluateReproduction>;
      try {
        derivedReproduction = evaluateReproduction(sourceAttempts.map((attempt) => ({
          attemptId: String(attempt?.attemptId), status: String(attempt?.status), failureClassification: String(attempt?.failureClassification),
        })), unsafeRerunReason === undefined ? {} : { unsafeRerunReason });
      } catch (error: unknown) {
        return { code: "ARTIFACT_BINDING", message: error instanceof Error ? error.message : "Bug reproduction is invalid" };
      }
      if (JSON.stringify(value.reproduction) !== JSON.stringify(derivedReproduction)) return { code: "ARTIFACT_BINDING", message: "Bug reproduction must equal the registered attempt evaluation" };
      const existingBugs = registeredValues("bug-report");
      const sameFingerprint = existingBugs.filter((bug) => bug.fingerprint === value.fingerprint);
      const prior = [...sameFingerprint].sort((left, right) => (typeof right.revision === "number" ? right.revision : 1) - (typeof left.revision === "number" ? left.revision : 1))[0];
      const expectedBugId = prior?.bugId ?? createRunScopedBugId(String(original.testCaseId), ctx.runId, new Set(existingBugs.map((bug) => String(bug.bugId))).size + 1);
      const expectedRevision = prior ? (typeof prior.revision === "number" ? prior.revision : 1) + 1 : 1;
      const priorRecord = prior ? ctx.relatedOfType("bug-report").find((candidate) => candidate.value?.bugId === prior.bugId && candidate.value?.revision === prior.revision) : undefined;
      // The attempt-uniqueness `.some(...)` — same shape as `testResultRule`'s, so it reads the same way:
      // a non-empty bucket means this attempt already has a bug report.
      if (value.bugId !== expectedBugId || indexByAttemptId(existingBugs, (bug) => bug.attemptId).get(value.attemptId).length > 0
        || (value.revision !== undefined && value.revision !== expectedRevision)
        || (prior && (!priorRecord || value.supersedesArtifactId !== priorRecord.record.id || !ctx.relationships.includes(priorRecord.record.id)))) {
        return { code: "ARTIFACT_BINDING", message: "Bug ID or original-attempt identity is not deterministic" };
      }
      if (!Array.isArray(value.affectedAreas) || typeof value.expected !== "string" || typeof value.actual !== "string"
        || value.fingerprint !== createBugFingerprint({ feature: String(original.testCaseId), expected: value.expected, actual: value.actual, affectedAreas: value.affectedAreas.map(String) })) {
        return { code: "ARTIFACT_BINDING", message: "Bug fingerprint is not canonical" };
      }
      // Keyed on `evidenceId` (the per-id conjunct), leaving the `sourceAttemptIds.includes(...)`
      // MEMBERSHIP conjunct as the residual filter — membership over a list is not an equality and so
      // is not indexable without changing which artifacts the count covers. The count is unchanged
      // because `evidenceId` equality partitions the pool.
      const evidenceByEvidenceId = indexByKey(registeredValues("evidence"), (evidence) => evidence.evidenceId);
      const evidenceIds = value.evidenceIds;
      if (!Array.isArray(evidenceIds) || !evidenceIds.every((evidenceId) => evidenceByEvidenceId.get(evidenceId).filter(
        (evidence) => sourceAttemptIds.includes(evidenceAttemptId(evidence)),
      ).length === 1)) {
        return { code: "ARTIFACT_BINDING", message: "Bug report references unregistered or ambiguous evidence for its reproduction set" };
      }
      const evidenceArtifactIds = isRecord(value.provenance) && Array.isArray(value.provenance.evidenceArtifactIds) ? value.provenance.evidenceArtifactIds : [];
      if (!evidenceArtifactIds.every((id) => {
        if (typeof id !== "string") return false;
        return ctx.registeredRecord(id, "evidence") !== undefined && ctx.relationships.includes(id);
      })) {
        return { code: "ARTIFACT_BINDING", message: "Bug report evidence provenance is not registered" };
      }
      const testCase = indexByTestCaseIdentity(registeredValues("test-case"), (candidate) => ({ testCaseId: candidate.testCaseId, testCaseRevisionId: candidate.revisionId, testCaseInstanceId: candidate.instanceId }))
        .get({ testCaseId: original.testCaseId, testCaseRevisionId: original.testCaseRevisionId, testCaseInstanceId: original.testCaseInstanceId })[0];
      const plans = registeredValues("test-plan");
      const approvedPlanCase = plans.flatMap((plan) => plan.approvalDecision && isRecord(plan.approvalDecision) && plan.approvalDecision.approved === true && Array.isArray(plan.testCases)
        ? plan.testCases.filter(isRecord).filter((candidate) => candidate.testCaseId === original.testCaseId && (!isRecord(candidate.browserExecution) || candidate.browserExecution.revisionId === original.testCaseRevisionId)) : [])
        .find((candidate) => Array.isArray(candidate.expectedResults));
      const plannedExpected = approvedPlanCase && Array.isArray(approvedPlanCase.expectedResults)
        ? approvedPlanCase.expectedResults.filter(isRecord).filter((item) => typeof item.text === "string" && item.text.length > 0).map((item) => item.text).join(" ") : undefined;
      const coverage = testCase?.coverage;
      const derivedExpected = plannedExpected || (isRecord(coverage) && typeof coverage.outcome === "string" ? coverage.outcome : testCase?.title);
      const steps = registeredValues("test-step-result");
      const observedStep = steps.find((step) => sourceAttemptIds.includes(String(step.attemptId)) && (typeof step.observedActual === "string" || typeof step.error === "string"));
      const evidence = registeredValues("evidence");
      const observedTelemetry = evidence.flatMap((item) => sourceAttemptIds.includes(evidenceAttemptId(item)) ? array(item.telemetryFindings) : []).find((item) => isRecord(item) && typeof item.message === "string");
      const derivedActual = typeof observedStep?.observedActual === "string" ? observedStep.observedActual
        : typeof observedStep?.error === "string" ? observedStep.error
          : isRecord(observedTelemetry) && typeof observedTelemetry.message === "string" ? observedTelemetry.message
            : "Unknown observed actual (no registered step, error, or telemetry observation).";
      if (value.expected !== derivedExpected || value.actual !== derivedActual
        || (derivedActual.startsWith("Unknown observed actual") && (!Array.isArray(value.openQuestions) || !value.openQuestions.includes("No registered observable actual was available.")))) {
        return { code: "ARTIFACT_BINDING", message: "Bug expected and actual must derive from the approved testcase revision and registered failed observation" };
      }
      if (value.possibleDuplicateSources !== undefined) {
        if (!Array.isArray(value.possibleDuplicateSources)) return { code: "ARTIFACT_BINDING", message: "Cross-run duplicate sources are invalid" };
        for (const source of value.possibleDuplicateSources) {
          if (!isRecord(source) || typeof source.runId !== "string" || source.runId === ctx.runId || typeof source.artifactId !== "string" || typeof source.sha256 !== "string" || typeof source.bugId !== "string" || source.fingerprint !== value.fingerprint) {
            return { code: "ARTIFACT_BINDING", message: "Cross-run duplicate source is not an explicit checksum-bound reference" };
          }
          const comparison = await ctx.openRun(source.runId);
          try {
            const sourceRecord = await comparison.readArtifactRecord(source.artifactId);
            const sourceArtifact = (await comparison.readRegisteredArtifacts()).find((candidate) => candidate.record.id === source.artifactId && candidate.record.type === "bug-report");
            if (!sourceArtifact || sourceRecord.sha256 !== source.sha256 || sourceArtifact.value?.runId !== source.runId || sourceArtifact.value?.bugId !== source.bugId || sourceArtifact.value?.fingerprint !== source.fingerprint) {
              return { code: "ARTIFACT_BINDING", message: "Cross-run duplicate source snapshot does not match its trusted workspace artifact" };
            }
          } finally { await comparison.close(); }
        }
      }
      return undefined;
    }
    // On READ, `ctx.relatedOfType` re-filters and re-maps the whole cascade-sensitive valid pool on every
    // call, so the two scans that called it from INSIDE a loop (the evidence `.every()` and the
    // `sourceAttemptIds.map()`) rebuilt that pool once per id, per bug report, per fixpoint pass. Both now
    // read one index. The pool is fixed for the duration of one rule evaluation, so hoisting is safe here;
    // it is the FIXPOINT that must rebuild, and it does (see `inspectWorkspaceState`).
    const resultsByAttempt = indexByAttemptId(ctx.relatedOfType("test-result"), attemptIdOf);
    const matchingAttempts = resultsByAttempt.get(value.attemptId);
    const evidenceIds = value.evidenceIds;
    const sourceAttemptIds = isRecord(value.provenance) && Array.isArray(value.provenance.sourceAttemptIds) ? value.provenance.sourceAttemptIds : [];
    const evidenceByEvidenceId = indexByKey(ctx.relatedOfType("evidence"), (candidate) => candidate.value?.evidenceId);
    const evidenceValid = Array.isArray(evidenceIds) && evidenceIds.every((evidenceId) =>
      evidenceByEvidenceId.get(evidenceId).filter((candidate) =>
        sourceAttemptIds.includes(evidenceAttemptId(candidate.value))
      ).length === 1
    );
    const sourceAttempts = sourceAttemptIds.map((attemptId) => resultsByAttempt.get(attemptId)[0]?.value);
    let reproductionValid = false;
    try {
      reproductionValid = sourceAttempts.every((attempt) => attempt !== undefined)
        && canonicalJson(value.reproduction) === canonicalJson(evaluateReproduction(sourceAttempts.filter((attempt): attempt is Record<string, unknown> => attempt !== undefined).map((attempt) => ({ attemptId: String(attempt.attemptId), status: String(attempt.status), failureClassification: String(attempt.failureClassification) })), isRecord(value.reproduction) && typeof value.reproduction.unsafeRerunReason === "string" ? { unsafeRerunReason: value.reproduction.unsafeRerunReason } : {}));
    } catch { reproductionValid = false; }
    const original = matchingAttempts[0]?.value;
    const caseValue = original === undefined ? undefined : indexByTestCaseIdentity(ctx.relatedOfType("test-case"), testCaseIdentityOf)
      .get({ testCaseId: original.testCaseId, testCaseRevisionId: original.testCaseRevisionId, testCaseInstanceId: original.testCaseInstanceId })[0]?.value;
    const approvedPlanCase = original === undefined ? undefined : ctx.relatedOfType("test-plan").flatMap((candidate) => isRecord(candidate.value?.approvalDecision) && candidate.value.approvalDecision.approved === true && Array.isArray(candidate.value.testCases)
      ? candidate.value.testCases.filter(isRecord).filter((planCase) => planCase.testCaseId === original.testCaseId && (!isRecord(planCase.browserExecution) || planCase.browserExecution.revisionId === original.testCaseRevisionId)) : [])
      .find((planCase) => Array.isArray(planCase.expectedResults));
    const plannedExpected = approvedPlanCase && Array.isArray(approvedPlanCase.expectedResults) ? approvedPlanCase.expectedResults.filter(isRecord).filter((item) => typeof item.text === "string" && item.text.length > 0).map((item) => item.text).join(" ") : undefined;
    const expected = plannedExpected || (isRecord(caseValue?.coverage) && typeof caseValue.coverage.outcome === "string" ? caseValue.coverage.outcome : caseValue?.title);
    const observed = ctx.relatedOfType("test-step-result").map((candidate) => candidate.value).find((step) => sourceAttemptIds.includes(step?.attemptId) && (typeof step?.observedActual === "string" || typeof step?.error === "string"));
    const telemetry = ctx.relatedOfType("evidence").flatMap((candidate) => sourceAttemptIds.includes(evidenceAttemptId(candidate.value)) ? array(candidate.value?.telemetryFindings) : []).find((finding) => isRecord(finding) && typeof finding.message === "string");
    const actual = typeof observed?.observedActual === "string" ? observed.observedActual : typeof observed?.error === "string" ? observed.error : isRecord(telemetry) && typeof telemetry.message === "string" ? telemetry.message : "Unknown observed actual (no registered step, error, or telemetry observation).";
    const revision = typeof value.revision === "number" ? value.revision : 1;
    const siblings = ctx.relatedOfType("bug-report").filter((candidate) => candidate.value?.bugId === value.bugId);
    const predecessor = revision > 1 ? siblings.find((candidate) => candidate.record.id === value.supersedesArtifactId && candidate.value?.fingerprint === value.fingerprint && (typeof candidate.value?.revision === "number" ? candidate.value.revision : 1) === revision - 1) : undefined;
    const duplicateRevision = siblings.filter((candidate) => (typeof candidate.value?.revision === "number" ? candidate.value.revision : 1) === revision).length !== 1;
    let duplicateSourcesValid = Array.isArray(value.possibleDuplicateSources) || value.possibleDuplicateSources === undefined;
    if (Array.isArray(value.possibleDuplicateSources)) for (const source of value.possibleDuplicateSources) {
      if (!isRecord(source) || typeof source.runId !== "string" || source.runId === ctx.runId || typeof source.artifactId !== "string" || typeof source.sha256 !== "string" || source.fingerprint !== value.fingerprint || typeof source.bugId !== "string") { duplicateSourcesValid = false; continue; }
      try {
        const comparison = await ctx.openRun(source.runId);
        try {
          const sourceRecord = await comparison.readArtifactRecord(source.artifactId);
          const sourceArtifact = (await comparison.readRegisteredArtifacts()).find((candidate) => candidate.record.id === source.artifactId && candidate.record.type === "bug-report");
          if (!sourceArtifact || sourceRecord.sha256 !== source.sha256 || sourceArtifact.value?.runId !== source.runId || sourceArtifact.value?.bugId !== source.bugId || sourceArtifact.value?.fingerprint !== source.fingerprint) duplicateSourcesValid = false;
        } finally { await comparison.close(); }
      } catch { duplicateSourcesValid = false; }
    }
    if (matchingAttempts.length !== 1 || !evidenceValid || !reproductionValid || value.expected !== expected || value.actual !== actual || !duplicateSourcesValid || duplicateRevision || (revision > 1 && (!predecessor || !ctx.relationships.includes(predecessor.record.id))) || (revision === 1 && value.supersedesArtifactId !== undefined)) {
      return { code: "ARTIFACT_BINDING", message: "Bug report must reference one attempt and registered evidence from that attempt" };
    }
    return undefined;
  },
};

/** Rule: `cleanup-run` — ASYNC via file provenance (`assertCleanupProvenance` reads the source run's
 *  files), not cross-run open. NO per-path drift: both stages run the same distinct-immutable-source
 *  linkage check then the same provenance re-verification, surfacing identical messages (`error.message`
 *  fallback). No `ctx.stage` branch. Faithful to write `assertSemanticReferences` cleanup-run branch and
 *  read inline cleanup-run branch. */
const cleanupRunRule: SemanticRule = {
  type: "cleanup-run",
  appliesTo: { write: true, read: true },
  async: true,
  async evaluate(ctx) {
    const value = ctx.value;
    if (value.runId !== ctx.runId || typeof value.sourceRunId !== "string" || value.sourceRunId === ctx.runId || value.sourceRunId !== ctx.linkedRunId) {
      return { code: "ARTIFACT_BINDING", message: "Cleanup run must be linked to a distinct immutable source run" };
    }
    try {
      await assertCleanupProvenance(ctx.path, value);
    } catch (error: unknown) {
      return { code: "ARTIFACT_BINDING", message: error instanceof Error ? error.message : "Cleanup provenance is invalid" };
    }
    return undefined;
  },
};

/** Rule: `regression-selection` — sync but heavy. Per-path message AND logic drift. WRITE derives the
 *  expected relationship set by INDEX correspondence between the manifest test-case records and their
 *  re-read values (both from the disk-backed pool) and emits three messages (run-id mismatch, main
 *  binding, unmapped-risk); READ resolves decision cases from the cascade-sensitive valid pool and folds
 *  everything into one combined message. Faithful to write `assertSemanticReferences` regression-selection
 *  branch and read inline regression-selection branch. */
const regressionSelectionRule: SemanticRule = {
  type: "regression-selection",
  appliesTo: { write: true, read: true },
  async: false,
  evaluate(ctx) {
    const value = ctx.value;
    if (ctx.stage === "write") {
      if (value.runId !== ctx.runId) return { code: "ARTIFACT_BINDING", message: "Regression selection run ID does not match this workspace" };
      const related = ctx.relatedOfType("test-case");
      const cases = related.map((candidate) => candidate.value as Record<string, unknown>);
      const decisions = [...array(value.selected), ...array(value.excluded)];
      // The removed scan resolved each candidate record through `caseRecords.findIndex(record.id)` and
      // then read the value at that POSITION, so it matched on the value of the FIRST related artifact
      // carrying that record id — not necessarily the candidate's own. Keying the identity index by that
      // same resolution reproduces the outer `.find()` exactly (both take the first match in pool order)
      // without assuming record ids are unique, and collapses a scan that was quadratic in the pool.
      const relatedByRecordId = indexByKey(related, (candidate) => candidate.record.id);
      const casesByResolvedIdentity = indexByTestCaseIdentity(related, (candidate) => {
        const testCase = relatedByRecordId.get(candidate.record.id)[0]?.value;
        return { testCaseId: testCase?.testCaseId, testCaseRevisionId: testCase?.revisionId, testCaseInstanceId: testCase?.instanceId };
      });
      const expectedRelationships = decisions.map((decision) => isRecord(decision)
        ? casesByResolvedIdentity.get({ testCaseId: decision.testCaseId, testCaseRevisionId: decision.revisionId, testCaseInstanceId: decision.instanceId })[0]?.record.id
        : undefined);
      const scopeRelated = ctx.relatedOfType("change-scope").find((candidate) => candidate.record.id === value.changeScopeArtifactId);
      const scope = scopeRelated?.record;
      const scopeValue = scopeRelated?.value;
      const recomputed = scopeValue && Array.isArray(scopeValue.changes) ? selectRegressionCases({ changes: scopeValue.changes as never, testCases: cases.map((testCase) => regressionCaseFromCanonical(testCase)) }) : undefined;
      const stored = { selected: value.selected, excluded: value.excluded, unmappedChangeRisks: value.unmappedChangeRisks, complete: value.complete };
      if (!scope || scope.sha256 !== value.changeScopeSha256 || value.decisionChecksum !== sha256Text(JSON.stringify(stored)) || recomputed === undefined || canonicalJson(stored) !== canonicalJson(recomputed) || !decisions.every((decision) => isRecord(decision) && cases.some((testCase) => testCase.testCaseId === decision.testCaseId && testCase.revisionId === decision.revisionId && testCase.instanceId === decision.instanceId)) || expectedRelationships.some((id) => id === undefined) || JSON.stringify([...ctx.relationships].sort()) !== JSON.stringify([scope.id, ...expectedRelationships.filter((id): id is string => id !== undefined)].sort())) {
        return { code: "ARTIFACT_BINDING", message: "Regression selection decisions must bind registered canonical test case revisions" };
      }
      if (value.complete === true && Array.isArray(value.unmappedChangeRisks) && value.unmappedChangeRisks.length > 0) {
        return { code: "ARTIFACT_BINDING", message: "Unmapped change risks prevent a complete regression claim" };
      }
      return undefined;
    }
    const decisions = [...array(value.selected), ...array(value.excluded)];
    const testCases = ctx.relatedOfType("test-case");
    // `.filter()` → the full bucket: the `decisionCases.length !== decisions.length` ambiguity decision
    // stays at its call site below, so a decision matching two cases still counts twice.
    const casesByIdentity = indexByTestCaseIdentity(testCases, testCaseIdentityOf);
    const decisionCases = decisions.flatMap((decision) => isRecord(decision) ? casesByIdentity.get({ testCaseId: decision.testCaseId, testCaseRevisionId: decision.revisionId, testCaseInstanceId: decision.instanceId }) : []);
    const relationshipIds = [...ctx.relationships].sort();
    const expectedIds = decisionCases.map((testCase) => testCase.record.id).sort();
    const scope = ctx.relatedOfType("change-scope").find((candidate) => candidate.record.id === value.changeScopeArtifactId);
    const expectedDecisionChecksum = sha256Text(JSON.stringify({ selected: value.selected, excluded: value.excluded, unmappedChangeRisks: value.unmappedChangeRisks, complete: value.complete }));
    const recomputed = scope?.value && Array.isArray(scope.value.changes) ? selectRegressionCases({ changes: scope.value.changes as never, testCases: testCases.flatMap((testCase) => testCase.value === undefined ? [] : [regressionCaseFromCanonical(testCase.value)]) }) : undefined;
    if (value.runId !== ctx.runId || !scope || scope.record.sha256 !== value.changeScopeSha256 || value.decisionChecksum !== expectedDecisionChecksum || recomputed === undefined || canonicalJson({ selected: value.selected, excluded: value.excluded, unmappedChangeRisks: value.unmappedChangeRisks, complete: value.complete }) !== canonicalJson(recomputed) || decisionCases.length !== decisions.length || JSON.stringify(relationshipIds) !== JSON.stringify([scope.record.id, ...expectedIds].sort()) || (value.complete === true && array(value.unmappedChangeRisks).length > 0)) {
      return { code: "ARTIFACT_BINDING", message: "Regression selection must bind every decision to one registered case and expose unmapped risk" };
    }
    return undefined;
  },
};

/** Rule: `retest-result` — ASYNC (reopens `value.sourceRunId` via `ctx.openRun`). Per-path message drift
 *  plus the cross-run reconstruction: WRITE re-reads occurrences with distinct messages and PROPAGATES a
 *  reopen error (uncaught, inside the `try/finally`); READ folds into one combined message and SWALLOWS a
 *  reopen error (`catch → sourceBugValid = false`). The source view is `close()`d in a `finally` on both
 *  paths. Faithful to write `assertSemanticReferences` retest-result branch and read inline branch. */
const retestResultRule: SemanticRule = {
  type: "retest-result",
  appliesTo: { write: true, read: true },
  async: true,
  async evaluate(ctx) {
    const value = ctx.value;
    if (ctx.stage === "write") {
      if (value.runId !== ctx.runId || value.sourceRunId !== ctx.linkedRunId || typeof value.sourceRunId !== "string" || value.sourceRunId === ctx.runId) {
        return { code: "ARTIFACT_BINDING", message: "Retest result must bind this linked immutable source run" };
      }
      // Replaces the parallel `attempts` / `resultRecords` arrays this branch used to walk with
      // `.find()` / `.findIndex()`: both were positional views of the SAME pool, so one index over the
      // pool serves the value lookups and the record-id lookups, and `[0]` is the element `.findIndex`
      // would have located (both take the first match in pool order).
      const resultsByAttempt = indexByAttemptId(ctx.relatedOfType("test-result"), attemptIdOf);
      const source = await ctx.openRun(value.sourceRunId);
      try {
        const sourceArtifacts = await source.readRegisteredArtifacts();
        const bug = sourceArtifacts.find((candidate) => candidate.record.id === value.sourceBugArtifactId && candidate.record.type === "bug-report");
        const bugValue = bug?.value;
        if (!bugValue || bugValue.bugId !== value.bugId || typeof bugValue.attemptId !== "string") return { code: "ARTIFACT_BINDING", message: "Retest result source bug is not registered" };
        const ids = Array.isArray(value.reproductionAttemptIds) ? value.reproductionAttemptIds : [];
        const reproduced = ids.map((id) => resultsByAttempt.get(id)[0]?.value);
        const sourceIds = isRecord(bugValue.provenance) && Array.isArray(bugValue.provenance.sourceAttemptIds) ? bugValue.provenance.sourceAttemptIds.filter((id): id is string => typeof id === "string") : [String(bugValue.attemptId)];
        const sourceResultsByAttempt = indexByAttemptId(sourceArtifacts.filter((candidate) => candidate.record.type === "test-result"), attemptIdOf);
        const sourceOccurrences = sourceIds.map((id) => sourceResultsByAttempt.get(id)[0]).map((attempt) => {
          const testCase = attempt === undefined ? undefined : sourceArtifacts.find((candidate) => candidate.record.type === "test-case" && attempt.record.relationships.includes(candidate.record.id));
          return attempt === undefined || testCase === undefined || testCase.value?.testCaseId !== attempt.value?.testCaseId || testCase.value?.revisionId !== attempt.value?.testCaseRevisionId || testCase.value?.instanceId !== attempt.value?.testCaseInstanceId ? undefined : { attemptId: attempt.record.id, testCaseId: testCase.record.id, scenarioId: sourceScenarioId({ testCaseId: String(attempt.value?.testCaseId), revisionId: String(attempt.value?.testCaseRevisionId), instanceId: String(attempt.value?.testCaseInstanceId) }) };
        });
        const sourceScenarios = sourceOccurrences.map((item) => item?.scenarioId ?? "");
        if (sourceOccurrences.some((item) => item === undefined) || sourceScenarios.length === 0 || reproduced.length === 0 || !sameStringOccurrences(reproduced.filter((attempt): attempt is NonNullable<typeof attempt> => attempt !== undefined).map((attempt) => sourceScenarioId({ testCaseId: String(attempt.testCaseId), revisionId: String(attempt.testCaseRevisionId), instanceId: String(attempt.testCaseInstanceId) })), sourceScenarios)) {
          return { code: "ARTIFACT_BINDING", message: "Retest result must use exact registered reproduction attempts" };
        }
        const regressionIds = Array.isArray(value.regressionAttemptIds) ? value.regressionAttemptIds : [];
        const regression = regressionIds.map((id) => resultsByAttempt.get(id)[0]?.value);
        const scenarios = Array.isArray(value.reproductionScenarios) ? value.reproductionScenarios : [];
        const scenarioValid = scenarios.length === reproduced.length && scenarios.every((scenario, index) => isRecord(scenario) && scenario.attemptId === ids[index] && scenario.status === reproduced[index]?.status && scenario.sourceAttemptArtifactId === sourceOccurrences[index]?.attemptId && scenario.sourceTestCaseArtifactId === sourceOccurrences[index]?.testCaseId && scenario.scenarioId === sourceOccurrences[index]?.scenarioId) && sameStringOccurrences(scenarios.filter(isRecord).map((scenario) => String(scenario.scenarioId)), sourceScenarios);
        const regressionOutcome = deriveRegressionOutcome(regression.map((attempt) => String(attempt?.status)));
        const derived = deriveRetestVerdict({ originalBugId: String(bugValue.bugId), reproductionStatuses: scenarios.map((scenario) => String(isRecord(scenario) ? scenario.status : "")), scenarioIds: scenarios.map((scenario) => String(isRecord(scenario) ? scenario.scenarioId : "")), regressionOutcome });
        const expectedRelationships = ids.map((id) => resultsByAttempt.get(id)[0]?.record.id).filter((id): id is string => id !== undefined).sort();
        const regressionRelationships = regressionIds.map((id) => resultsByAttempt.get(id)[0]?.record.id).filter((id): id is string => id !== undefined).sort();
        if (!scenarioValid || regression.some((attempt) => !attempt) || value.regressionOutcome !== regressionOutcome || value.verdict !== derived.verdict || JSON.stringify([...ctx.relationships].sort()) !== JSON.stringify([...expectedRelationships, ...regressionRelationships].sort())) return { code: "ARTIFACT_BINDING", message: "Retest verdict and relationships must derive from the exact reproduction independently of regression" };
        return undefined;
      } finally { await source.close(); }
    }
    const reproductionIds = array(value.reproductionAttemptIds);
    // Both maps called `ctx.relatedOfType` per id, rebuilding the whole read-path valid pool each time.
    const resultsByAttempt = indexByAttemptId(ctx.relatedOfType("test-result"), attemptIdOf);
    const attempts = reproductionIds.map((id) => resultsByAttempt.get(id)[0]);
    const regressionAttempts = array(value.regressionAttemptIds).map((id) => resultsByAttempt.get(id)[0]);
    const relationships = [...attempts, ...regressionAttempts].map((attempt) => attempt?.record.id).filter((id): id is string => id !== undefined).sort();
    const sourceMatchesLink = typeof value.sourceRunId === "string" && value.sourceRunId === ctx.linkedRunId && value.sourceRunId !== ctx.runId;
    const scenarios = array(value.reproductionScenarios);
    const scenarioValid = scenarios.length === attempts.length && scenarios.every((scenario, index) => isRecord(scenario) && scenario.attemptId === reproductionIds[index] && scenario.status === attempts[index]?.value?.status && typeof scenario.scenarioId === "string");
    const derivedOutcome = regressionAttempts.length === array(value.regressionAttemptIds).length ? (() => { try { return deriveRegressionOutcome(regressionAttempts.map((attempt) => String(attempt?.value?.status))); } catch { return undefined; } })() : undefined;
    const derived = typeof value.bugId === "string" && scenarioValid ? deriveRetestVerdict({ originalBugId: value.bugId, reproductionStatuses: scenarios.map((scenario) => String(isRecord(scenario) ? scenario.status : "")), scenarioIds: scenarios.map((scenario) => String(isRecord(scenario) ? scenario.scenarioId : "")), ...(derivedOutcome === undefined ? {} : { regressionOutcome: derivedOutcome }) }) : undefined;
    let sourceBugValid = false;
    let reproductionMatchesSource = false;
    if (sourceMatchesLink && typeof value.sourceBugArtifactId === "string" && typeof value.sourceBugArtifactSha256 === "string" && typeof value.bugId === "string") try {
      const source = await ctx.openRun(value.sourceRunId as string);
      try {
        const sourceRecord = await source.readArtifactRecord(value.sourceBugArtifactId);
        const sourceArtifacts = await source.readRegisteredArtifacts();
        const sourceBug = sourceArtifacts.find((candidate) => candidate.record.id === value.sourceBugArtifactId && candidate.record.type === "bug-report");
        const sourceBugValue = sourceBug?.value;
        sourceBugValid = sourceRecord.type === "bug-report" && sourceRecord.sha256 === value.sourceBugArtifactSha256 && sourceBugValue?.bugId === value.bugId;
        const ids = sourceBugValue !== undefined && isRecord(sourceBugValue.provenance) && Array.isArray(sourceBugValue.provenance.sourceAttemptIds) ? sourceBugValue.provenance.sourceAttemptIds.filter((id): id is string => typeof id === "string") : sourceBug === undefined ? [] : [String(sourceBugValue?.attemptId)];
        const sourceResultsByAttempt = indexByAttemptId(sourceArtifacts.filter((candidate) => candidate.record.type === "test-result"), attemptIdOf);
        const sourceOccurrences = ids.map((id) => sourceResultsByAttempt.get(id)[0]).map((attempt) => {
          const testCase = attempt === undefined ? undefined : sourceArtifacts.find((candidate) => candidate.record.type === "test-case" && attempt.record.relationships.includes(candidate.record.id));
          return attempt === undefined || testCase === undefined || testCase.value?.testCaseId !== attempt.value?.testCaseId || testCase.value?.revisionId !== attempt.value?.testCaseRevisionId || testCase.value?.instanceId !== attempt.value?.testCaseInstanceId ? undefined : { attemptId: attempt.record.id, testCaseId: testCase.record.id, scenarioId: sourceScenarioId({ testCaseId: String(attempt.value?.testCaseId), revisionId: String(attempt.value?.testCaseRevisionId), instanceId: String(attempt.value?.testCaseInstanceId) }) };
        });
        const sourceScenarios = sourceOccurrences.map((item) => item?.scenarioId ?? "");
        const sourceIdentityMatches = sourceOccurrences.every((source, index) => source !== undefined && isRecord(scenarios[index]) && scenarios[index].sourceAttemptArtifactId === source.attemptId && scenarios[index].sourceTestCaseArtifactId === source.testCaseId && scenarios[index].scenarioId === source.scenarioId);
        const reproducedScenarios = attempts.map((attempt) => attempt?.value === undefined ? "" : sourceScenarioId({ testCaseId: String(attempt.value.testCaseId), revisionId: String(attempt.value.testCaseRevisionId), instanceId: String(attempt.value.testCaseInstanceId) }));
        reproductionMatchesSource = sourceScenarios.length > 0 && sourceIdentityMatches && sameStringOccurrences(reproducedScenarios, sourceScenarios) && sameStringOccurrences(scenarios.filter(isRecord).map((scenario) => String(scenario.scenarioId)), sourceScenarios);
      } finally { await source.close(); }
    } catch { sourceBugValid = false; }
    if (value.runId !== ctx.runId || !sourceMatchesLink || !sourceBugValid || !reproductionMatchesSource || attempts.length === 0 || attempts.some((attempt) => !attempt) || regressionAttempts.some((attempt) => !attempt) || !scenarioValid || value.regressionOutcome !== derivedOutcome || JSON.stringify([...ctx.relationships].sort()) !== JSON.stringify(relationships) || value.verdict !== derived?.verdict) {
      return { code: "ARTIFACT_BINDING", message: "Retest result must bind linked source and exact reproduction artifacts with a derived verdict" };
    }
    return undefined;
  },
};

/** Rule: `evidence` — WRITE-only (`appliesTo.read === false`). Like `evidence-gap`, the READ side is
 *  DELIBERATELY LEFT INLINE in `inspectWorkspaceState`'s in-fixpoint loop and is NOT migrated: the old
 *  read code ran block A (attempt/testcase identity) and block B (derived-screenshot descriptor↔raw
 *  checksum) as two INDEPENDENT `if`s, so a derived screenshot with BOTH its attempt binding AND its
 *  derivation tampered emits TWO `INVALID_REFERENCE` diagnostics in one pass. Routing read through this
 *  single-violation rule (which returns the FIRST violation) would collapse that to ONE diagnostic — an
 *  observable change to the diagnostic set/count for a constructible input. So read stays inline
 *  (two independent emissions preserved); only the WRITE branch is migrated here, and the write path
 *  faithfully throws on the FIRST violation. The per-path message drift (write message here; read block
 *  A message inline) is preserved, not reconciled. Block A uses `ctx.relatedOfType("test-result")` (the
 *  on-disk registered set) with the WRITE-only "exactly one test-result relationship" guard; block B
 *  keys descriptor↔binary on the manifest record's `mediaType` via `ctx.registeredRecord`. Faithful to
 *  the write `assertSemanticReferences` evidence branch. */
const evidenceRule: SemanticRule = {
  type: "evidence",
  appliesTo: { write: true, read: false },
  async: false,
  evaluate(ctx) {
    const value = ctx.value;
    const subject = evidenceSubject(value);
    if (subject === undefined) {
      return { code: "ARTIFACT_BINDING", message: "Evidence binding requires one exact registered test result relationship and matching testcase identity" };
    }
    if (subject.kind === "observed-execution") {
      // An observed execution has no attempt to bind to, so the attempt-identity check below is not
      // merely skipped — it is replaced by the positive assertion that the record claims no attempt.
      // Its execution binding is the `test-result-batch` artifact's concern, not evidence's.
      if (ctx.relationships.some((id) => ctx.registeredRecord(id, "test-result") !== undefined)) {
        return { code: "ARTIFACT_BINDING", message: "Observed-execution evidence must not claim a test result relationship" };
      }
    } else {
      const matches = indexByAttemptId(ctx.relatedOfType("test-result"), attemptIdOf).get(subject.attemptId);
      const match = matches[0];
      const identityFail = matches.length !== 1 || match === undefined
        || ctx.relationships.filter((id) => id === match.record.id).length !== 1
        || subject.testCaseId !== match.value?.testCaseId
        || subject.testCaseRevisionId !== match.value?.testCaseRevisionId
        || subject.testCaseInstanceId !== match.value?.testCaseInstanceId;
      if (identityFail || ctx.relationships.filter((id) => ctx.registeredRecord(id, "test-result") !== undefined).length !== 1) {
        return { code: "ARTIFACT_BINDING", message: "Evidence binding requires one exact registered test result relationship and matching testcase identity" };
      }
    }
    const derivation = isRecord(value.derivation) ? value.derivation : undefined;
    const sourceEvidenceId = derivation?.sourceEvidenceArtifactId;
    const sourceBinaryId = derivation?.sourceBinaryArtifactId;
    const derivedFromDescriptor = ctx.relationships.some((id) => {
      const record = ctx.registeredRecord(id, "evidence");
      return record !== undefined && record.mediaType === undefined;
    });
    if (derivedFromDescriptor) {
      const descriptorRecord = typeof sourceEvidenceId === "string" ? ctx.registeredRecord(sourceEvidenceId, "evidence") : undefined;
      const sourceDescriptor = descriptorRecord !== undefined && descriptorRecord.mediaType === undefined ? descriptorRecord : undefined;
      const binaryRecord = typeof sourceBinaryId === "string" ? ctx.registeredRecord(sourceBinaryId, "evidence") : undefined;
      const sourceBinary = binaryRecord !== undefined && binaryRecord.mediaType === "image/png" ? binaryRecord : undefined;
      if (!derivation || !sourceDescriptor || !sourceBinary
        || derivation.sourceEvidenceSha256 !== sourceDescriptor.sha256
        || derivation.sourceRawSha256 !== sourceBinary.sha256
        || !ctx.relationships.includes(sourceDescriptor.id)
        || !ctx.relationships.includes(sourceBinary.id)) {
        return { code: "ARTIFACT_BINDING", message: "Derived screenshot must preserve exact source descriptor and raw checksum relationships" };
      }
    }
    return undefined;
  },
};

/** Rule: `evidence-gap` — WRITE-only (`appliesTo.read === false`). The READ side is DELIBERATELY LEFT
 *  INLINE in `inspectWorkspaceState`'s POST-fixpoint evidence/evidence-gap loop and is NOT migrated:
 *  routing it through the in-fixpoint rule dispatch would move it out of its post-fixpoint slot and
 *  could cascade-invalidate an `incident` that binds a malformed-scope evidence-gap (which the current
 *  post-fixpoint timing keeps valid during the fixpoint), changing the diagnostic set — exactly the
 *  ordering hazard the design flags (risk 3). Migrating only the WRITE branch still collapses the write
 *  chain; the write/read drift is PRESERVED (not reconciled). Faithful to write
 *  `assertSemanticReferences` evidence-gap branch. */
const evidenceGapRule: SemanticRule = {
  type: "evidence-gap",
  appliesTo: { write: true, read: false },
  async: false,
  evaluate(ctx) {
    const value = ctx.value;
    if (value.scope === "operational") {
      if (value.attemptId !== undefined || value.testCaseId !== undefined || value.testCaseRevisionId !== undefined || value.testCaseInstanceId !== undefined
        || ctx.relationships.some((id) => ctx.registeredRecord(id, "test-result") !== undefined)) {
        return { code: "ARTIFACT_BINDING", message: "Operational Evidence Gap must not claim an attempt binding" };
      }
      return undefined;
    }
    const results = indexByAttemptId(ctx.relatedOfType("test-result"), attemptIdOf).get(value.attemptId);
    const result = results[0];
    if (value.scope !== "attempt" || results.length !== 1
      || ctx.relationships.filter((id) => id === result?.record.id).length !== 1
      || ctx.relationships.filter((id) => ctx.registeredRecord(id, "test-result") !== undefined).length !== 1
      || value.testCaseId !== result?.value?.testCaseId || value.testCaseRevisionId !== result?.value?.testCaseRevisionId || value.testCaseInstanceId !== result?.value?.testCaseInstanceId) {
      return { code: "ARTIFACT_BINDING", message: "Attempt-scoped Evidence Gap requires one exact registered test result relationship and matching testcase identity" };
    }
    return undefined;
  },
};

/** Rule: `change-scope` — READ-only (`appliesTo.write === false`); `change-scope` has no write
 *  `assertSemanticReferences` branch today. Re-verifies the persisted input checksum and run binding.
 *  Dispatched in the in-fixpoint read slot (identical to its former inline position — cascade to
 *  `regression-selection` preserved). Faithful to read `inspectWorkspaceState` in-fixpoint change-scope
 *  branch. */
const changeScopeRule: SemanticRule = {
  type: "change-scope",
  appliesTo: { write: false, read: true },
  async: false,
  evaluate(ctx) {
    const value = ctx.value;
    const expectedChecksum = sha256Text(JSON.stringify({ changes: value.changes, provenance: value.provenance }));
    if (value.runId !== ctx.runId || value.inputChecksum !== expectedChecksum) {
      return { code: "ARTIFACT_BINDING", message: "Change scope checksum does not match its registered mapping input" };
    }
    return undefined;
  },
};

/** The shared table. Task 14 migrated the three overlapping planning types; Task 15a added the eight
 *  synchronous "both-path" types; Task 15b added the three async + regression heavy-derivation types;
 *  Task 15c adds `evidence` (write-only — read stays inline in-fixpoint to preserve its two independent
 *  diagnostics), `evidence-gap` (write-only — read stays inline post-fixpoint), and `change-scope`
 *  (read-only), finalizing the in-fixpoint migration. Task 29 adds `test-result-batch`, the first type
 *  authored directly onto this table (both paths, no drift); Task 34 adds `human-attestation` the same
 *  way. Types with no per-type semantic
 *  rule on either path (`test-case`, `exploratory-finding`, `run-metadata`, `artifact-manifest`),
 *  `environment-profile` (inline in `assertArtifactBinding`), and `workflow-checkpoint` (read-only,
 *  post-fixpoint inline) intentionally remain outside the table. */
export const semanticRules: Partial<Record<ArtifactType, SemanticRule>> = {
  "requirement-analysis": requirementAnalysisRule,
  "coverage-obligation": coverageObligationRule,
  "test-plan": testPlanRule,
  "test-result": testResultRule,
  "test-result-batch": testResultBatchRule,
  "approval-decision": approvalDecisionRule,
  "human-attestation": humanAttestationRule,
  "test-step-result": testStepResultRule,
  "incident": incidentRule,
  "release-gate": releaseGateRule,
  "qa-execution-report": qaExecutionReportRule,
  "test-data-manifest": testDataManifestRule,
  "exploration-charter": explorationCharterRule,
  "bug-report": bugReportRule,
  "cleanup-run": cleanupRunRule,
  "regression-selection": regressionSelectionRule,
  "retest-result": retestResultRule,
  "evidence": evidenceRule,
  "evidence-gap": evidenceGapRule,
  "change-scope": changeScopeRule,
};

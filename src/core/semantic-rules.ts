import type { ArtifactType } from "../contracts/types.js";
import { deriveTestPlanApproval, type ApprovalDecision, type ApprovalEnvironment } from "../planning/approval.js";
import { assertRequirementAuthorities } from "../planning/authority.js";
import type { ArtifactRecord } from "./artifact-record.js";
import type { ArtifactProfileName } from "./artifact-profiles.js";
import { isRecord } from "./values.js";

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

/** The shared table. Only the three overlapping planning types are migrated in Task 14; every other
 *  type stays on its legacy write branch / read inline-chain branch (the adapters fall through). */
export const semanticRules: Partial<Record<ArtifactType, SemanticRule>> = {
  "requirement-analysis": requirementAnalysisRule,
  "coverage-obligation": coverageObligationRule,
  "test-plan": testPlanRule,
};

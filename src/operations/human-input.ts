import type { WorkflowOperationName } from "../core/modes.js";
import type { RunWorkspace } from "../core/run-workspace.js";
import { isManualAccessibilityMethod } from "../planning/coverage.js";
import { resolvePlanApproval } from "../planning/approval.js";
import { gateSourceArtifacts, resolveGateObligations } from "../reporting/release-gate.js";

/**
 * The `AWAITING_HUMAN_INPUT` seam: the point at which a run stops and waits for a person.
 *
 * Two commands write artifacts only a person can supply — `qa-skill approval record` and
 * `qa-skill attestation record` — and until this module existed neither had a reachable position in
 * any run that produces a release gate: `runQaTesterWithAdapters` executed the whole operation order
 * and finalized in one invocation, after which the workspace refuses every write.
 *
 * The governing rule for every predicate below is the same, and it is the reason this is not simply
 * "pause whenever something is unsatisfied":
 *
 *   **Pause only when the named command would succeed AND would change the run's verdict.**
 *
 * The negation is what matters. An obligation on an Execution Surface no executor covers, an
 * `automated-analysis` obligation no scanner can satisfy, an obligation whose requirement is not
 * AUTHORITATIVE (so no attestation could ever credit it), an optional obligation, and an
 * `auto-approve-safe` plan that derived `approved: false` for a safety reason are all UNSATISFIED and
 * none of them is WAITING. Phase 6 made the first of those reach the gate as an honest `NOT_READY` on
 * purpose; turning any of them into a pause would convert an honest verdict into an indefinite hang,
 * which is strictly worse than the gap this seam closes.
 */

/** One registered artifact a person must act on before the paused run can continue. */
export type PendingHumanInputSubject = Readonly<{
  /** The registered artifact the missing human record must bind to. */
  artifactId: string;
  /** Its immutable checksum at the moment the run paused. */
  sha256: string;
  /** The value the resolving command names it by: `--plan-artifact-id` for an approval (the artifact
   *  id itself), `--obligation-id` for an attestation (the obligation's own declared ID). */
  reference: string;
  /** The manual accessibility method the obligation declares — the `--method` the attestation must
   *  carry, since `recordHumanAttestation` refuses any other. Absent for an approval. */
  method?: string;
}>;

/**
 * What a paused run tells its caller. `AWAITING_RUNTIME` returns a bare outcome because its remedy is
 * a caller-side registry the caller already knows about; a human staring at `AWAITING_HUMAN_INPUT`
 * knows neither what to record nor which artifact to record it against, so the result carries both.
 */
export type PendingHumanInput = Readonly<{
  kind: "approval" | "attestation";
  /** The operation the run stopped in front of, and will resume at. */
  operation: WorkflowOperationName;
  /** The `qa-skill` command that records the missing artifact. */
  command: "approval record" | "attestation record";
  /** One stable sentence naming what is missing and why the run stopped. */
  reason: string;
  subjects: readonly PendingHumanInputSubject[];
}>;

function approvalPause(subjects: readonly PendingHumanInputSubject[]): PendingHumanInput | undefined {
  if (subjects.length === 0) return undefined;
  return {
    kind: "approval",
    operation: "execute-browser-test",
    command: "approval record",
    reason: "Execution requires a human approval decision for a human-review test plan.",
    subjects,
  };
}

function attestationPause(subjects: readonly PendingHumanInputSubject[]): PendingHumanInput | undefined {
  if (subjects.length === 0) return undefined;
  return {
    kind: "attestation",
    operation: "generate-qa-report",
    command: "attestation record",
    reason: "The release gate requires a Human Attestation for a required manual accessibility obligation.",
    subjects,
  };
}

/**
 * Decides whether the operation the loop is about to run must wait for a person, evaluated against
 * exactly what is registered at that moment.
 *
 * The operation gate is here rather than at the call site so the pool is read only for the two guarded
 * operations, and so the operation-to-predicate mapping lives in one place:
 *
 * - `execute-browser-test` is where an unapproved plan would otherwise throw
 *   ("Test case plan binding is not approved"), and the plan exists from the planning import onwards.
 * - `generate-qa-report` is where the gate is snapshotted, and a Coverage Obligation only exists after
 *   `ingest-coverage-obligation` (or, in `regression` mode, after the canonical bundle import). It is
 *   also the LAST position at which an attestation can still be registered: a `release-gate` is an
 *   immutable re-derivable snapshot, so an attestation registered after it exists makes the persisted
 *   gate mismatch its own re-derivation forever.
 *
 * `executionCaseIds` is the exact set `executeWithRuntime` is about to drive, so the approval
 * predicate is evaluated over precisely the cases that would otherwise throw — never over cases a
 * regression selection excluded.
 */
export async function pendingHumanInput(
  workspace: RunWorkspace,
  operation: WorkflowOperationName,
  executionCaseIds: readonly string[],
): Promise<PendingHumanInput | undefined> {
  if (operation !== "execute-browser-test" && operation !== "generate-qa-report") return undefined;
  const artifacts = await workspace.readRegisteredArtifacts();
  if (operation === "execute-browser-test") {
    const plans = new Map<string, PendingHumanInputSubject>();
    for (const caseArtifactId of executionCaseIds) {
      const testCase = artifacts.find((artifact) => artifact.record.id === caseArtifactId && artifact.record.type === "test-case");
      if (testCase === undefined) continue;
      const { plan, awaitsHumanReview } = resolvePlanApproval(artifacts, testCase);
      // A case with no plan, or with a plan no command can resolve, is deliberately left to the
      // existing throw: it is unapproved and un-approvable, not waiting.
      if (plan === undefined || !awaitsHumanReview) continue;
      plans.set(plan.record.id, { artifactId: plan.record.id, sha256: plan.record.sha256, reference: plan.record.id });
    }
    return approvalPause([...plans.values()].sort((left, right) => left.artifactId.localeCompare(right.artifactId)));
  }
  // Asked of the SAME reader the gate itself uses, so "the gate would report this required obligation
  // missing" and "the pause thinks it is open" cannot drift apart.
  const resolved = resolveGateObligations(gateSourceArtifacts(artifacts));
  // Counted from the RAW registered pool — the same pool, and the same `value.obligationId` field,
  // that `recordHumanAttestation` (src/operations/record-human-attestation.ts) itself counts against —
  // rather than from `resolved` above. Today the two pools agree by construction anyway: every field
  // `resolveGateObligations` can drop a `coverage-obligation` record on (`obligationId`, `requirementId`,
  // `role`, `behavior`, `risk`, `outcome`, `executionSurface`, and browser/viewport when the surface is
  // `browser`) is schema-constrained, so no registered obligation ever fails its guards. Counting from
  // the raw pool means the ambiguity check stays correct even if that ever stops being true, instead of
  // relying on the schema to keep two independently-filtered counts in sync — the same "two readers must
  // not disagree" hazard this module's other comments call out.
  const carriers = new Map<unknown, number>();
  for (const artifact of artifacts) {
    if (artifact.record.type !== "coverage-obligation") continue;
    carriers.set(artifact.value.obligationId, (carriers.get(artifact.value.obligationId) ?? 0) + 1);
  }
  const subjects = resolved.flatMap(({ record, obligation }): PendingHumanInputSubject[] => {
    // `required`: an optional obligation is reported as an optional gap (READY_WITH_RISKS), which is an
    // honest "not covered" — stopping the run for one would be a pause nothing forces anyone to clear.
    // `isManualAccessibilityMethod`: the exact set `recordHumanAttestation` accepts. `automated-analysis`
    // and any unrecognised label have no producer at all (CONTEXT.md:438).
    // `authoritativeRequirement`: `evaluateCoverage` credits an attestation only for an AUTHORITATIVE
    // requirement, so without this the recorded attestation would not clear the obligation and the
    // resume would pause again — forever.
    // `humanAttested`: already satisfied; nothing to wait for.
    if (!obligation.required || obligation.humanAttested || !obligation.authoritativeRequirement) return [];
    if (!isManualAccessibilityMethod(obligation.accessibilityMethod)) return [];
    // `recordHumanAttestation` refuses unless EXACTLY ONE registered obligation carries the id it is
    // given, and `obligationId` is not unique across a workspace. Pausing on an ambiguous id would name
    // a command that cannot run.
    if (carriers.get(obligation.obligationId) !== 1) return [];
    return [{ artifactId: record.id, sha256: record.sha256, reference: obligation.obligationId, method: obligation.accessibilityMethod }];
  });
  return attestationPause([...subjects].sort((left, right) => left.reference.localeCompare(right.reference)));
}

import type { DefectSeverity } from "../defects/triage.js";
import { indexByTestCaseIdentity } from "../core/artifact-index.js";
import { creditsAttestation, creditsCoverage } from "../core/provenance.js";
import { isRecord } from "../core/values.js";
import { profileDeclaresProtectedEnvironment } from "../evidence/protection.js";
import { asExecutionSurface, evaluateCoverage, type ClaimLane, type CoverageAttempt, type ResolvedCoverageObligation } from "../planning/coverage.js";

export type GateBug = Readonly<{ bugId: string; triageStatus: "NEEDS_TRIAGE" | "TRIAGED"; severity?: DefectSeverity; open: boolean }>;
export type ReleaseGateInput = Readonly<{
  artifactsValid: boolean;
  coverage: Readonly<{ requiredMissing: readonly string[]; optionalGaps: readonly string[]; requiredHighRisk: readonly { obligationId: string; passed: boolean }[] }>;
  bugs: readonly GateBug[];
  sharedBlockers: readonly string[];
}>;
export type RuleVerdict = Readonly<{ rule: string; passed: boolean; reason: string }>;
export type ReleaseGateResult = Readonly<{ recommendation: "READY" | "READY_WITH_RISKS" | "NOT_READY"; ruleInputs: ReleaseGateInput; verdicts: readonly RuleVerdict[] }>;
/** The gate's go/no-go verdict, reused wherever a caller surfaces it without recomputing the gate. */
export type ReleaseRecommendation = ReleaseGateResult["recommendation"];
export type GateSourceArtifact = Readonly<{ id: string; sha256: string; type: string }>;
export type DerivedReleaseGate = ReleaseGateResult & Readonly<{ sourceArtifacts: readonly GateSourceArtifact[] }>;
/**
 * The workspace-derived gate additionally carries the deterministic protected-environment LABEL
 * (D12). It is derived purely from the persisted environment-profile, is INFORMATIONAL, and never
 * affects the recommendation. Only `deriveReleaseGateFromWorkspaceArtifacts` — which has the full
 * artifact set including the profile — can compute it.
 */
export type WorkspaceDerivedReleaseGate = DerivedReleaseGate & Readonly<{ protectedEnvironment: boolean; ruleInputs: WorkspaceGateRuleInputs }>;
/**
 * The rule inputs a WORKSPACE-derived gate persists: the four `evaluateReleaseGate` decides on, plus the
 * facts kept in the snapshot so a later policy change stays auditable and an omission stays detectable.
 *
 * Written down because the function has always RETURNED them — they are in every persisted `release-gate`
 * artifact and `releaseGateRule` compares them byte for byte on re-derivation — while the declared type
 * said `ReleaseGateInput` and stopped at four. `validationDiagnostics` in particular is now a fact this
 * derivation computes rather than a parameter, and a caller reading it should not have to cast.
 */
export type WorkspaceGateRuleInputs = ReleaseGateInput & Readonly<{
  incidents: readonly Readonly<Record<string, unknown>>[];
  evidenceGaps: readonly Readonly<Record<string, unknown>>[];
  cleanupLeaks: readonly Readonly<Record<string, unknown>>[];
  unmappedChangeRisks: readonly Readonly<Record<string, unknown>>[];
  /** One `unreadableGateArtifact` line per registered record this derivation could not read. */
  validationDiagnostics: readonly string[];
}>;
export type GateWorkspaceArtifact = Readonly<{
  record: GateSourceArtifact & Readonly<{ provenance?: string }>;
  value: Readonly<Record<string, unknown>>;
}>;

function string(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
/** A `{ width, height }` pair, or `undefined` when the value is not one. Byte-for-byte the check
 *  `browserDimensions` has always applied, factored out so an ATTEMPT's own reported viewport is read
 *  by exactly the same rule as an obligation's declared one. */
function viewportOf(value: unknown): { width: number; height: number } | undefined {
  return isRecord(value) && typeof value.width === "number" && typeof value.height === "number" ? { width: value.width, height: value.height } : undefined;
}
/**
 * The two dimensions only the `browser` surface owns, or `undefined` when they are malformed. Kept
 * exactly as strict as before for browser-surface records — a broken viewport still costs the record its
 * resolution, which since Phase 9 makes the record UNREADABLE rather than silently dropped (see
 * `unreadableGateArtifact`). It is only ever consulted for that surface, which is what lets a
 * non-browser obligation (which legitimately has neither) resolve at all.
 */
function browserDimensions(value: Readonly<Record<string, unknown>>): Readonly<{ browser: string; viewport: { width: number; height: number } }> | undefined {
  const viewport = viewportOf(value.viewport); const browser = string(value.browser);
  if (browser === undefined || viewport === undefined) return undefined;
  return { browser, viewport };
}
/**
 * The surface a claim ran on and, on the browser surface only, the engine and viewport it ran at —
 * the whole of what `ClaimLane` decides. `undefined` means DROP, this reader's answer to every
 * unresolvable record.
 *
 * `driven-attempt` derives `browser` and pairs the claim's observed engine with the viewport the
 * runtime SET from the test case's declaration; `observed-entry` reads all three off the entry and
 * falls back to nothing, so a batch entry that names no surface is dropped rather than promoted to
 * `browser`. The `??` that would collapse those two branches into one is exactly the accident this
 * shape exists to prevent.
 */
function attemptSurface(lane: ClaimLane, claim: Readonly<Record<string, unknown>>, declaredViewport: { width: number; height: number }): Pick<CoverageAttempt, "executionSurface" | "observedEngine" | "viewport"> | undefined {
  const observedEngine = string(claim.observedEngine);
  if (lane === "driven-attempt") {
    // The MEASURED engine, off the claim itself rather than the test case (CONTEXT.md:442). Absent means
    // DROP: the `test-result` schema requires the field, so a registered artifact always carries it, and
    // falling back to the declared label is exactly the mis-credit this replaces.
    return observedEngine === undefined ? undefined : { executionSurface: "browser", observedEngine, viewport: declaredViewport };
  }
  const surface = asExecutionSurface(claim.executionSurface);
  if (surface === undefined) return undefined;
  // Off the browser surface the entry's schema FORBIDS both, so neither is read and neither is compared
  // (`matchesBrowserDimensions` only consults them for a browser obligation). A stray value on such an
  // entry is therefore inert here, exactly as a stray `browser`/`viewport` on a non-browser obligation
  // already is above — the schema is what rejects it, not this reader.
  if (surface !== "browser") return { executionSurface: surface };
  const viewport = viewportOf(claim.viewport);
  return observedEngine === undefined || viewport === undefined ? undefined : { executionSurface: surface, observedEngine, viewport };
}
function canonical<T>(items: readonly T[], key: (item: T) => string): readonly T[] { return [...items].sort((left, right) => key(left).localeCompare(key(right))); }

/**
 * The one wording every fail-CLOSED refusal in this file uses, and the whole of item 3.1 (D9).
 *
 * Every reader below takes UNVALIDATED records and, until Phase 9, answered a record it could not resolve
 * by returning `[]` — dropping it in silence. For an ATTEMPT that direction was safe (a dropped attempt
 * withholds credit), but for an OBLIGATION and for a BUG it was fail-OPEN in the dangerous direction: a
 * required critical obligation that was merely malformed vanished from every coverage bucket, and an open
 * Critical bug whose `open` field was a string vanished from `bugs`, either of which left a `READY`
 * verdict. Ten characterization comments promised since July that "Phase 3/D9 will change this to
 * NOT_READY"; this is that change.
 *
 * The record is REPORTED rather than reinterpreted. It is deliberately NOT named in
 * `coverage.requiredMissing`: those ids are `obligationId`s that every downstream projection resolves
 * back to a registered obligation, and the id is one of the fields that can be the malformed one, so
 * naming a malformed record there would put a name in a checksummed audit artifact that resolves to
 * nothing. `VALID_ARTIFACTS` — "One or more registered artifacts are invalid" — is the rule that already
 * means exactly this, it is a HARD rule, and the verdict is the promised NOT_READY either way.
 *
 * Reachability, measured rather than assumed: no registered artifact can reach any of these lines. Every
 * field an obligation is refused on is in `coverage-obligation.schema.json`'s `required` list under
 * `additionalProperties: false` (with `browser`/`viewport` conditionally required for the browser
 * surface); the same holds for `test-result`, for a `test-result-batch` entry, for `test-case.coverage`,
 * and for `bug-report` — whose `allOf` additionally makes `severity` required for a TRIAGED bug. On top
 * of the schemas, `testResultRule` and `testResultBatchRule` (src/core/semantic-rules.ts) bind every
 * claim to exactly one registered test case. So this is defense in depth on an exported pure function
 * whose real callers are schema-protected, and every gate a real run can reach is byte-identical to the
 * one it produced before.
 */
function unreadableGateArtifact(record: GateWorkspaceArtifact["record"]): string {
  return `${record.type} ${record.id} is not readable by the release gate`;
}

/**
 * The workspace facts that are shared blockers, phrased once, because BOTH derivations below state them
 * and a second copy is free to disagree. `deriveReleaseGateFromArtifacts` used to ACCEPT `incidents`,
 * `evidenceGaps` and `cleanupLeaks` and read none of them, so the same environment incident that blocked
 * the workspace-derived gate passed the sibling one; routing both through this function is what closes
 * that (item 3.1's last pinned drop).
 *
 * `isRecord` rather than a cast: the sibling's inputs are `readonly unknown[]`, and a non-record among
 * them is not a fact this function can state. The workspace variant's inputs are already artifact values,
 * so the guard is inert there and the output stays byte-identical for every run.
 */
function sharedBlockerFacts(facts: Readonly<{
  incidents: readonly unknown[];
  evidenceGaps: readonly unknown[];
  cleanupLeaks: readonly unknown[];
  unmappedChangeRisks: readonly unknown[];
  validationDiagnostics: readonly string[];
}>): readonly string[] {
  return [
    ...facts.incidents.filter(isRecord).filter((incident) => incident.kind === "ENVIRONMENT_INCIDENT").map((incident) => `Environment incident ${String(incident.incidentId)}`),
    ...facts.evidenceGaps.filter(isRecord).map((gap) => `Evidence gap ${String(gap.evidenceGapId)} affects ${String(gap.affectedClaim)}`),
    ...facts.cleanupLeaks.filter(isRecord).map((leak) => `Cleanup leak ${String(leak.id)}`),
    ...facts.unmappedChangeRisks.filter(isRecord).map((risk) => `Unmapped change risk ${String(risk.changeId)}`),
    ...facts.validationDiagnostics.map((diagnostic) => `Validation diagnostic ${diagnostic}`),
  ];
}

/** Deterministic policy only: narrative code may describe this result but cannot alter it. */
export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateResult {
  const open = input.bugs.filter((bug) => bug.open);
  const untriaged = open.filter((bug) => bug.triageStatus === "NEEDS_TRIAGE");
  const blockers = open.filter((bug) => bug.triageStatus === "TRIAGED" && (bug.severity === "Blocker" || bug.severity === "Critical"));
  const nonCritical = open.filter((bug) => bug.triageStatus === "TRIAGED" && bug.severity !== "Blocker" && bug.severity !== "Critical");
  const highRiskMisses = input.coverage.requiredHighRisk.filter((obligation) => !obligation.passed);
  const verdicts: RuleVerdict[] = [
    { rule: "VALID_ARTIFACTS", passed: input.artifactsValid, reason: input.artifactsValid ? "All registered artifacts are valid." : "One or more registered artifacts are invalid." },
    { rule: "NO_SHARED_BLOCKERS", passed: input.sharedBlockers.length === 0, reason: input.sharedBlockers.length === 0 ? "No shared blockers are present." : `Shared blockers: ${input.sharedBlockers.join(", ")}.` },
    { rule: "NO_OPEN_BLOCKER_OR_CRITICAL", passed: blockers.length === 0, reason: blockers.length === 0 ? "No open Blocker or Critical product bug." : `Open Blocker/Critical bugs: ${blockers.map((bug) => bug.bugId).join(", ")}.` },
    { rule: "NO_UNTRIAGED_PRODUCT_BUG", passed: untriaged.length === 0, reason: untriaged.length === 0 ? "No open untriaged product bug." : `Open untriaged bugs: ${untriaged.map((bug) => bug.bugId).join(", ")}.` },
    { rule: "REQUIRED_HIGH_RISK_PASSED", passed: highRiskMisses.length === 0, reason: highRiskMisses.length === 0 ? "All required high-risk obligations passed." : `Required high-risk obligations not passing: ${highRiskMisses.map((item) => item.obligationId).join(", ")}.` },
    { rule: "REQUIRED_COVERAGE_COMPLETE", passed: input.coverage.requiredMissing.length === 0, reason: input.coverage.requiredMissing.length === 0 ? "All required coverage obligations are satisfied." : `Required coverage missing: ${input.coverage.requiredMissing.join(", ")}.` },
  ];
  const hardFailure = verdicts.some((verdict) => !verdict.passed);
  if (hardFailure) return { recommendation: "NOT_READY", ruleInputs: input, verdicts };
  const hasRisks = input.coverage.optionalGaps.length > 0 || nonCritical.length > 0;
  const completion: RuleVerdict = {
    rule: "NO_OPEN_PRODUCT_DEFECT_FOR_READY",
    passed: open.length === 0,
    reason: open.length === 0 ? "No open product defect remains." : `Open non-critical product bugs: ${nonCritical.map((bug) => bug.bugId).join(", ")}.`,
  };
  return { recommendation: hasRisks ? "READY_WITH_RISKS" : "READY", ruleInputs: input, verdicts: [...verdicts, completion] };
}

/** Binds the gate to the exact immutable source artifact records used to evaluate it. */
export function deriveReleaseGateFromArtifacts(input: Readonly<{
  artifactRecords: readonly GateSourceArtifact[];
  coverage: ReleaseGateInput["coverage"];
  bugs: readonly GateBug[];
  incidents: readonly unknown[];
  evidenceGaps: readonly unknown[];
  cleanupLeaks: readonly unknown[];
  sharedBlockers: readonly string[];
  artifactsValid: boolean;
}>): DerivedReleaseGate {
  const sourceArtifacts = [...input.artifactRecords].sort((left, right) => left.id.localeCompare(right.id));
  // The three inputs this function has always ACCEPTED are the three it now READS, through the same
  // `sharedBlockerFacts` the workspace derivation uses. `unmappedChangeRisks` and `validationDiagnostics`
  // are empty because this shape carries neither — a caller holding them has the workspace pool and
  // belongs in `deriveReleaseGateFromWorkspaceArtifacts`.
  const sharedBlockers = canonical([...input.sharedBlockers, ...sharedBlockerFacts({
    incidents: input.incidents, evidenceGaps: input.evidenceGaps, cleanupLeaks: input.cleanupLeaks,
    unmappedChangeRisks: [], validationDiagnostics: [],
  })], (item) => item);
  const result = evaluateReleaseGate({ artifactsValid: input.artifactsValid, coverage: input.coverage, bugs: input.bugs, sharedBlockers });
  return { ...result, sourceArtifacts };
}

/**
 * The non-derived pool a gate is computed from: everything except the gate and report it produces, and
 * the workflow checkpoints that are operational resumability metadata rather than QA facts (including
 * later checkpoint revisions would retroactively invalidate an immutable gate).
 *
 * Exported so a caller that needs the gate's own view of the workspace BEFORE the gate exists — the
 * `AWAITING_HUMAN_INPUT` pause in `src/operations/run-workflow.ts` — filters by exactly this rule
 * rather than by an argument that the three excluded types happen not to matter.
 */
export function gateSourceArtifacts(artifacts: readonly GateWorkspaceArtifact[]): readonly GateWorkspaceArtifact[] {
  return artifacts.filter((artifact) => artifact.record.type !== "release-gate" && artifact.record.type !== "qa-execution-report" && artifact.record.type !== "workflow-checkpoint");
}

/** One registered `coverage-obligation` resolved exactly as the gate resolves it, paired with the
 *  immutable record it came from — the record is what carries the artifact id and checksum a caller
 *  needs to name the obligation, and what `humanAttested` was joined on. */
export type ResolvedGateObligation = Readonly<{ record: GateWorkspaceArtifact["record"]; obligation: ResolvedCoverageObligation }>;

/**
 * What `resolveGateObligations` found: the obligations it could resolve, and one `unreadableGateArtifact`
 * line per registered `coverage-obligation` it could not.
 *
 * A pair rather than a bare list because the second half must not be re-derivable by a second reader —
 * see `unreadableGateArtifact`. The pause in src/operations/human-input.ts takes only `resolved`: an
 * obligation nothing can read is not an obligation a Human Attestation could close, so pausing on one
 * would name a command that cannot run. The gate is what refuses it.
 */
export type GateObligationResolution = Readonly<{
  resolved: readonly ResolvedGateObligation[];
  diagnostics: readonly string[];
}>;

/**
 * Resolves every registered `coverage-obligation` against its requirement analysis and the run's Human
 * Attestations. Extracted from `deriveReleaseGateFromWorkspaceArtifacts` — which is still its only
 * caller for gate purposes — so the runtime pause can ask the SAME reader whether an obligation is
 * still open and whether an attestation could close it. A second, independently-written copy of this
 * resolution is exactly the "two readers of the same obligation disagree" hazard the notes below are
 * about.
 *
 * `source` must be `gateSourceArtifacts(...)`, not the raw pool.
 */
export function resolveGateObligations(source: readonly GateWorkspaceArtifact[]): GateObligationResolution {
  const valuesOf = (type: string) => source.filter((artifact) => artifact.record.type === type);
  const diagnostics: string[] = [];
  // The obligation BYTES every registered Human Attestation attests to (CONTEXT.md:438). The join key
  // is the checksum, not `obligationId`, because obligation ids are not unique across a workspace —
  // `obligationSha256` is the byte-exact binding the artifact carries precisely so a reader need not
  // trust an id. This attestation read stays SILENTLY DROPPING and re-validates nothing, and that is
  // deliberate rather than an oversight of the fail-CLOSED flip below: an attestation whose checksum is
  // missing or malformed contributes no credit, which is the only direction a bad attestation can move
  // the gate. Refusing the whole gate over one would turn a record that can only ever WITHHOLD credit
  // into a hard block, which is the opposite trade from an obligation or a bug — both of which could
  // move the gate towards READY by vanishing, and neither of which this reader may now drop.
  //
  // A SEMANTICALLY invalid one (wrong method, unbound obligation) cannot reach a READY gate either —
  // NOT because it lands in `validationDiagnostics` (this function raises a diagnostic only for a
  // `coverage-obligation` record it cannot resolve, never for an attestation), but because every live
  // caller's `artifacts` pool already excludes an invalid attestation before it reaches this function.
  // `generateQaReport` and `evaluateWorkspaceCoverage` both source
  // from `RunWorkspace.readRegisteredArtifacts`, which throws on the first diagnostic and returns only
  // `artifact.valid` records. `releaseGateRule`'s READ stage instead derives from the cascade-sensitive
  // valid pool built in `inspect-workspace-state.ts` (`ctx.related()`): an artifact invalidated in pass
  // N stays visible within pass N and drops out only in pass N+1, so a forged attestation can credit
  // transiently within one pass, but at fixpoint it is gone, the re-derived gate then reports the
  // obligation missing, and the persisted gate mismatches it and is itself flagged `ARTIFACT_BINDING`
  // (`releaseGateRule` in semantic-rules.ts). Neither this function nor `evaluateCoverage` is exported
  // from the package's public surface (`package.json`'s `exports` names only `qa-tester.ts` and
  // `cli/index.ts`), so no caller outside this repo can hand either an unvalidated set either.
  //
  // The type+checksum join is necessary but not sufficient: credit also requires the record to have
  // been STAMPED by the one producer that can make the claim. `creditsAttestation` is the attestation
  // sibling of the `creditsCoverage` gate every attempt path below already passes through, and it makes
  // this reader enforce what the schema's own `attestedBy` description asserts. Fail-OPEN is preserved:
  // a record that fails the predicate is dropped, which can only withhold credit.
  const attestedObligationChecksums = new Set(valuesOf("human-attestation").filter((artifact) => creditsAttestation(artifact.record.provenance)).flatMap((artifact) => {
    const checksum = string(artifact.value.obligationSha256);
    return checksum === undefined ? [] : [checksum];
  }));
  const resolved = valuesOf("coverage-obligation").flatMap((artifact): ResolvedGateObligation[] => {
    const value = artifact.value;
    const unreadable = (): ResolvedGateObligation[] => { diagnostics.push(unreadableGateArtifact(artifact.record)); return []; };
    const analysis = source.find((candidate) => candidate.record.id === value.requirementAnalysisArtifactId && candidate.record.type === "requirement-analysis");
    const authoritative = array(analysis?.value.statements).some((statement) => isRecord(statement) && statement.requirementId === value.requirementId && statement.authority === "AUTHORITATIVE");
    // An obligation with no recognizable surface is malformed (the schema requires one) and is refused
    // exactly like any other unreadable record. A VALID non-browser surface is the opposite case: it
    // carries neither engine nor viewport by design and must flow through to the coverage buckets, so
    // an Execution Surface no executor covers stays explicitly unmet rather than absent (CONTEXT.md:445).
    // That distinction is what the two outcomes here mean, and it survives the fail-CLOSED flip: an
    // unexecutable surface is named in `requiredMissing`, an unreadable record is named in the gate's
    // diagnostics. Both block; only the first one can say WHICH obligation is unmet.
    const surface = asExecutionSurface(value.executionSurface);
    if (surface === undefined) return unreadable();
    const geometry = surface === "browser" ? browserDimensions(value) : {};
    if (geometry === undefined) return unreadable();
    const fields = [value.obligationId, value.requirementId, value.role, value.behavior, value.risk, value.outcome];
    if (!fields.every((field) => string(field) !== undefined)) return unreadable();
    // `typeof`, NOT this file's `string()` helper, and not by accident. `string()` maps `""` to
    // `undefined`, and per CoverageObligation#accessibilityMethod `undefined` is the one value that
    // re-opens the ATTEMPT path — so an obligation carrying `accessibilityMethod: ""` would be
    // credited by a passing browser attempt here while `evaluate-workspace-coverage.ts` (which has
    // always used `typeof`) kept it unsatisfiable. The schema's enum makes `""` unreachable, so this
    // is defense-in-depth rather than a live fix; the point is that the two readers of the same
    // obligation must not disagree about what an empty label means, and the safe reading of an
    // unrecognised label is "still an Accessibility Obligation", never "not one at all".
    const accessibilityMethod = typeof value.accessibilityMethod === "string" ? value.accessibilityMethod : undefined;
    return [{ record: artifact.record, obligation: { obligationId: value.obligationId as string, requirementId: value.requirementId as string, executionSurface: surface, role: value.role as string, behavior: value.behavior as string, ...geometry, accessibilityMethod, risk: value.risk as string, required: value.required === true, outcome: value.outcome as string, authoritativeRequirement: authoritative, humanAttested: attestedObligationChecksums.has(artifact.record.sha256) } }];
  });
  return { resolved, diagnostics };
}

/**
 * The complete, immutable workspace is the sole source for a gate.  This is
 * deliberately shared by generation, registration, and workspace opening so
 * a caller cannot omit a troublesome fact from a hand-built rule snapshot.
 *
 * It takes ONE argument, and that is a ruling (item 3.4), not an omission. There used to be a second,
 * `validationDiagnostics: readonly string[] = []`, and no caller in `src/` ever passed it — both real
 * ones (`releaseGateRule` in src/core/semantic-rules.ts and src/operations/generate-qa-report.ts) call it
 * with one argument — so `VALID_ARTIFACTS` could not fail on any live path and `ruleInputs
 * .validationDiagnostics` was unconditionally `[]`. Phase 8a's ruling was DELETE IT, never start passing
 * it: the parameter is asymmetric across its two callers by construction, so a future change that made
 * only one of them pass a non-empty array would leave every ALREADY-PERSISTED gate permanently
 * mismatching its own re-derivation on read, and a gate artifact is immutable.
 *
 * `ruleInputs.validationDiagnostics` stays, with the same name and the same two consumers
 * (`artifactsValid`, and a `sharedBlockers` line). What changed is its SOURCE: it is no longer a
 * parameter nobody supplies, it is what THIS function could not read while deriving this gate. That
 * keeps the persisted shape byte-identical — every gate a real run can reach still carries `[]`, because
 * no registered artifact can reach an `unreadableGateArtifact` line — and gives the rule a source that
 * cannot go out of step with its caller, because it has no caller.
 */
export function deriveReleaseGateFromWorkspaceArtifacts(artifacts: readonly GateWorkspaceArtifact[]): WorkspaceDerivedReleaseGate {
  const source = gateSourceArtifacts(artifacts);
  const valuesOf = (type: string) => source.filter((artifact) => artifact.record.type === type);
  // Every record below that this gate cannot read lands here, deduplicated because one batch can hold
  // several unreadable entries and the artifact is what is being named. Sorted into `ruleInputs` by
  // `canonical` at the end, so collection order never reaches the persisted gate.
  const unreadable = new Set<string>();
  // One index over the registered test cases, consulted once per claim below. `artifacts` is a
  // parameter and this function registers nothing, so the pool is invariant for the whole call: the
  // index built here serves exactly the array `valuesOf("test-case")` returned, in that order.
  const casesByIdentity = indexByTestCaseIdentity(valuesOf("test-case"), (candidate) => ({ testCaseId: candidate.value.testCaseId, testCaseRevisionId: candidate.value.revisionId, testCaseInstanceId: candidate.value.instanceId }));
  const obligationResolution = resolveGateObligations(source);
  for (const diagnostic of obligationResolution.diagnostics) unreadable.add(diagnostic);
  const obligations: readonly ResolvedCoverageObligation[] = obligationResolution.resolved.map((resolved) => resolved.obligation);
  /** Flattens one identity-carrying claim (a per-attempt `test-result`, or one `test-result-batch`
   *  entry) into a CoverageAttempt. WHAT was covered comes from the single matching registered test
   *  case; HOW it ran comes from `attemptSurface` per `lane`. An unresolvable claim still credits
   *  nothing — that direction was never the fail-OPEN one — but it is now named as unreadable rather
   *  than dropped in silence, and `claimant` is the artifact RECORD that gets named: for lane 2 that is
   *  the batch manifest, because an entry has no id of its own outside the payload it is malformed in. */
  const asAttempt = (lane: ClaimLane, claimant: GateWorkspaceArtifact["record"], attemptId: unknown, status: unknown, identity: Readonly<Record<string, unknown>>): CoverageAttempt[] => {
    const refuse = (): CoverageAttempt[] => { unreadable.add(unreadableGateArtifact(claimant)); return []; };
    const testCase = casesByIdentity.get({ testCaseId: identity.testCaseId, testCaseRevisionId: identity.testCaseRevisionId, testCaseInstanceId: identity.testCaseInstanceId })[0];
    const dimensions = testCase?.value.coverage;
    if (!isRecord(dimensions)) return refuse();
    // `test-case.coverage` is browser-shaped by schema, so this guard runs for BOTH lanes and every
    // attempt-drop path is unchanged: a test case missing its declared engine or viewport is malformed,
    // and this reader has always dropped malformed records. What the guard's output is used FOR has
    // narrowed. `geometry.browser` is the test case's DECLARED engine, which per CONTEXT.md:442 no
    // longer takes part in crediting at all; `geometry.viewport` now reaches only lane 1, where the
    // runtime SET the live context from it — a lane-2 entry reports its own and never borrows this one.
    const geometry = browserDimensions(dimensions);
    if (geometry === undefined) return refuse();
    const surface = attemptSurface(lane, identity, geometry.viewport);
    if (surface === undefined) return refuse();
    const fields = [attemptId, status, dimensions.requirementId, dimensions.role, dimensions.behavior, dimensions.risk, dimensions.outcome];
    if (!fields.every((field) => string(field) !== undefined)) return refuse();
    // `dimensions.accessibilityMethod` is the SECOND declared label this reader drops on the floor
    // (after `geometry.browser`): an attempt cannot address an Accessibility Obligation at all, so the
    // test case's own label is neither necessary nor sufficient for any credit (CONTEXT.md:439).
    return [{ attemptId: attemptId as string, status: status as string, requirementId: dimensions.requirementId as string, ...surface, role: dimensions.role as string, behavior: dimensions.behavior as string, risk: dimensions.risk as string, outcome: dimensions.outcome as string }];
  };
  const attempts: CoverageAttempt[] = valuesOf("test-result").filter((artifact) => creditsCoverage(artifact.record.provenance))
    .flatMap((artifact) => asAttempt("driven-attempt", artifact.record, artifact.value.attemptId, artifact.value.status, artifact.value));
  // Lane 2 (ADR-0010): each `test-result-batch` entry is one observed case, keyed by `entryId` because
  // no runtime-driven attempt exists. Same provenance gate, so an agent-draft batch credits nothing.
  // The lane is fixed HERE, from the manifest record's type, and never sniffed off an entry's fields.
  //
  // `entries` is unwrapped explicitly rather than through `array()`/`.filter(isRecord)` for the same
  // reason every guard above changed: a batch whose `entries` is not an array, or that holds an entry
  // that is not an object, is a batch this reader cannot read, and the two helpers answered that by
  // yielding nothing. The schema requires an array of at least one object, so neither line is reachable
  // through registration. An EMPTY array is not refused — nothing is malformed about a batch with no
  // entries; it simply credits nothing.
  const batchAttempts: CoverageAttempt[] = valuesOf("test-result-batch").filter((artifact) => creditsCoverage(artifact.record.provenance))
    .flatMap((artifact) => {
      const entries = artifact.value.entries;
      if (!Array.isArray(entries)) { unreadable.add(unreadableGateArtifact(artifact.record)); return []; }
      return entries.flatMap((entry) => {
        if (!isRecord(entry)) { unreadable.add(unreadableGateArtifact(artifact.record)); return []; }
        return asAttempt("observed-entry", artifact.record, entry.entryId, entry.status, entry);
      });
    });
  const evaluation = evaluateCoverage(obligations, [...attempts, ...batchAttempts]);
  const passed = new Set(evaluation.satisfied);
  const highRisk = canonical(obligations.filter((obligation) => obligation.required && (obligation.risk === "high" || obligation.risk === "critical")).map((obligation) => ({ obligationId: obligation.obligationId, passed: passed.has(obligation.obligationId) })), (item) => item.obligationId);
  const optionalGaps = canonical(obligations.filter((obligation) => !obligation.required && !passed.has(obligation.obligationId)).map((obligation) => obligation.obligationId), (item) => item);
  const latestBugs = new Map<string, GateWorkspaceArtifact>();
  for (const artifact of valuesOf("bug-report")) {
    const bugId = string(artifact.value.bugId);
    // Without a `bugId` the record cannot even enter this map, so an open Critical blocker would never
    // reach `bugs` at all — the silent `continue` this replaces was the fail-OPEN drop with the shortest
    // path to a wrong verdict.
    if (!bugId) { unreadable.add(unreadableGateArtifact(artifact.record)); continue; }
    const current = latestBugs.get(bugId);
    const revision = typeof artifact.value.revision === "number" ? artifact.value.revision : 1;
    const currentRevision = typeof current?.value.revision === "number" ? current.value.revision : 1;
    if (!current || revision > currentRevision) latestBugs.set(bugId, artifact);
  }
  const bugs: readonly GateBug[] = canonical([...latestBugs.values()].flatMap((artifact): GateBug[] => {
    const value = artifact.value; const bugId = string(value.bugId); const triageStatus = value.triageStatus;
    if (!bugId || (triageStatus !== "NEEDS_TRIAGE" && triageStatus !== "TRIAGED") || typeof value.open !== "boolean") { unreadable.add(unreadableGateArtifact(artifact.record)); return []; }
    const severity = value.severity;
    const known = severity === "Blocker" || severity === "Critical" || severity === "Major" || severity === "Minor" || severity === "Trivial";
    // The severity half of the same flip. A TRIAGED bug carrying no severity, or one carrying a label
    // outside the enum, used to become a mere RISK — the gate silently stripped the field and the run
    // came back READY_WITH_RISKS. Both are severities this reader cannot map, and the safe reading of an
    // unmappable severity is "unreadable", never "harmless". The bug is still reported exactly as read:
    // inventing a severity would be the mirror-image mistake. `bug-report.schema.json`'s `allOf` makes
    // `severity` required for TRIAGED and enum-constrains it, so neither case is registerable.
    if (triageStatus === "TRIAGED" ? !known : severity !== undefined && !known) unreadable.add(unreadableGateArtifact(artifact.record));
    return [{ bugId, triageStatus, ...(known ? { severity } : {}), open: value.open }];
  }), (item) => item.bugId);
  const incidents = canonical(valuesOf("incident").map((artifact) => artifact.value), (item) => String(item.incidentId));
  const evidenceGaps = canonical(valuesOf("evidence-gap").map((artifact) => artifact.value), (item) => String(item.evidenceGapId));
  const cleanupLeaks: readonly Record<string, unknown>[] = canonical(valuesOf("cleanup-run").flatMap((artifact) => array(artifact.value.resources).filter(isRecord).filter((resource) => resource.status === "failed")), (item) => String(item.id));
  const unmappedChangeRisks = canonical(valuesOf("regression-selection").flatMap((artifact) => array(artifact.value.unmappedChangeRisks).filter(isRecord)), (item) => String(item.changeId));
  // Collected LAST, after every reader above has run: this is the complete list of records this
  // derivation could not read, and every one of them was reached before this line.
  const validationDiagnostics = canonical([...unreadable], (item) => item);
  const sharedBlockers = canonical(sharedBlockerFacts({ incidents, evidenceGaps, cleanupLeaks, unmappedChangeRisks, validationDiagnostics }), (item) => item);
  const ruleInputs = {
    artifactsValid: validationDiagnostics.length === 0,
    coverage: { requiredMissing: canonical(evaluation.missing, (item) => item), optionalGaps, requiredHighRisk: highRisk },
    bugs,
    sharedBlockers,
    incidents,
    evidenceGaps,
    cleanupLeaks,
    unmappedChangeRisks,
    validationDiagnostics: canonical(validationDiagnostics, (item) => item),
  };
  const result = evaluateReleaseGate(ruleInputs);
  // Deterministic protected-environment LABEL (D12): a pure function of the persisted
  // environment-profile(s). ANY registered profile that declares protection marks the run
  // protected (order-independent OR, so it stays deterministic). It is INFORMATIONAL — it is
  // NOT part of ruleInputs and never feeds evaluateReleaseGate, so it cannot change the
  // recommendation. Host-layer-only protection (never persisted in the profile) is deliberately
  // not reflected here; see profileDeclaresProtectedEnvironment.
  const protectedEnvironment = valuesOf("environment-profile").some((artifact) => profileDeclaresProtectedEnvironment(artifact.value));
  return {
    ...result,
    // Keep every workspace fact in the persisted snapshot, including facts
    // that are not presently policy-blocking, so later policy changes remain
    // auditable and omissions are detectable.
    ruleInputs,
    protectedEnvironment,
    sourceArtifacts: source
      .map((artifact) => ({ id: artifact.record.id, sha256: artifact.record.sha256, type: artifact.record.type }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

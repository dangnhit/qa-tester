import { indexByTestCaseIdentity } from "../core/artifact-index.js";
import { QaSkillsError } from "../core/errors.js";
import { creditsAttestation, creditsCoverage } from "../core/provenance.js";
import { RunWorkspace, type RegisteredWorkspaceArtifact } from "../core/run-workspace.js";
import { array, isRecord } from "../core/values.js";
import {
  asExecutionSurface,
  evaluateCoverage,
  type ClaimLane,
  type CoverageAttempt,
  type CoverageEvaluation,
  type CoverageObligation,
  type ExecutionSurface,
  type ResolvedCoverageObligation,
} from "../planning/coverage.js";

type RequirementStatement = { requirementId: string; authority: string };
/** Every dimension an ATTEMPT carries. Derived from `CoverageAttempt`, not `CoverageObligation`: since
 *  CONTEXT.md:442 the two shapes differ where it matters — an attempt has an `observedEngine`, an
 *  obligation a declared `browser`. Dropping a REQUIRED dimension from `dimensions()`'s return literal
 *  below has to be a compile error; `observedEngine` is the one exception, since it is optional on
 *  `CoverageAttempt`, so omitting it there would still type-check. It would still be caught, just later:
 *  the `observedEngine` parameter would go unused (`@typescript-eslint/no-unused-vars`, enforced via
 *  `recommendedTypeChecked` in `eslint.config.js`) and the credit tests would fail — fail-closed either
 *  way, just not at compile time for this one field. */
type CoverageDimensions = Omit<CoverageAttempt, "attemptId" | "status">;

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new QaSkillsError(`Registered ${label} is invalid`, "ARTIFACT_BINDING");
  return value;
}

/** A `{ width, height }` pair, or `undefined` when the value is not one. Byte-for-byte the check
 *  `browserDimensions` has always applied, factored out so an ATTEMPT's own reported viewport is read
 *  by exactly the same rule as an obligation's declared one — only the diagnostic differs. */
function viewportOf(value: unknown): { width: number; height: number } | undefined {
  return isRecord(value) && typeof value.width === "number" && typeof value.height === "number" ? { width: value.width, height: value.height } : undefined;
}

/**
 * The two dimensions only the `browser` surface owns. On every other surface the schema forbids them,
 * so they are not read at all — that absence is legitimate, not malformed, and is precisely what lets
 * an obligation the runtime cannot execute resolve and be reported unmet (CONTEXT.md:445). For the
 * browser surface the checks are byte-for-byte the ones this reader has always applied.
 */
function browserDimensions(surface: ExecutionSurface, value: Readonly<Record<string, unknown>>): Readonly<{ browser?: string; viewport?: { width: number; height: number } }> {
  if (surface !== "browser") return {};
  const viewport = viewportOf(value.viewport);
  if (viewport === undefined) throw new QaSkillsError("Registered coverage obligation viewport is invalid", "ARTIFACT_BINDING");
  return { browser: requireString(value.browser, "coverage obligation browser"), viewport };
}

function asObligation(value: Readonly<Record<string, unknown>>): CoverageObligation {
  const surface = asExecutionSurface(value.executionSurface);
  if (surface === undefined) throw new QaSkillsError("Registered coverage obligation execution surface is invalid", "ARTIFACT_BINDING");
  return {
    obligationId: requireString(value.obligationId, "coverage obligation ID"), requirementId: requireString(value.requirementId, "coverage obligation requirement ID"),
    executionSurface: surface, role: requireString(value.role, "coverage obligation role"), behavior: requireString(value.behavior, "coverage obligation behavior"),
    ...browserDimensions(surface, value), accessibilityMethod: typeof value.accessibilityMethod === "string" ? value.accessibilityMethod : undefined,
    risk: requireString(value.risk, "coverage obligation risk"), required: value.required === true, outcome: requireString(value.outcome, "coverage obligation outcome"),
  };
}

/**
 * The surface a claim ran on and, on the browser surface only, the engine and viewport it ran at —
 * the whole of what `ClaimLane` decides. This is the fail-CLOSED reader, so an unreadable value is
 * REJECTED rather than dropped: a drop here would silently grant credit the run did not earn.
 *
 * `driven-attempt` derives `browser` and pairs the claim's observed engine with the viewport the
 * runtime SET from the test case's declaration; `observed-entry` reads all three off the entry and
 * falls back to nothing, so an entry that names no surface is rejected rather than promoted to
 * `browser`. The `??` that would collapse those two branches into one is exactly the accident this
 * shape exists to prevent.
 *
 * Both `throw`s are defence in depth: `test-result-batch` 3.0.0 makes `executionSurface` a required
 * enum and a browser entry's `viewport` a required object, and `readRegisteredArtifacts` re-validates
 * every record against its contract before this function sees it — so reaching either means a
 * registered artifact stopped matching its own contract. `asObligation` already carries the identical
 * unreachable throw for an obligation's surface.
 */
function attemptSurface(lane: ClaimLane, claim: Readonly<Record<string, unknown>>, field: string, declaredViewport: { width: number; height: number } | undefined): Pick<CoverageAttempt, "executionSurface" | "observedEngine" | "viewport"> {
  // Read off the claim, never the test case (CONTEXT.md:442). Deferred rather than read up front so a
  // non-browser entry — which the schema forbids from naming an engine at all — never reaches it.
  const requireObservedEngine = () => requireString(claim.observedEngine, `${field} observed engine`);
  if (lane === "driven-attempt") return { executionSurface: "browser", observedEngine: requireObservedEngine(), viewport: declaredViewport };
  const surface = asExecutionSurface(claim.executionSurface);
  if (surface === undefined) throw new QaSkillsError(`Registered ${field} execution surface is invalid`, "ARTIFACT_BINDING");
  // Off the browser surface the entry's schema FORBIDS both, so neither is read and neither is compared
  // (`matchesBrowserDimensions` only consults them for a browser obligation).
  if (surface !== "browser") return { executionSurface: surface };
  const viewport = viewportOf(claim.viewport);
  if (viewport === undefined) throw new QaSkillsError(`Registered ${field} viewport is invalid`, "ARTIFACT_BINDING");
  return { executionSurface: surface, observedEngine: requireObservedEngine(), viewport };
}

/** The per-lane diagnostic labels: `field` names the malformed-field message, `subject` the
 *  orphan-binding one. Both are preserved verbatim per source, so each lane's diagnostics are exactly
 *  what that path emitted before; pairing them with the lane in ONE table is what stops a call site
 *  from asking for lane 1's derivation under lane 2's diagnostics. */
const claimLanes = {
  "driven-attempt": { field: "test result", subject: "Test result" },
  "observed-entry": { field: "test result batch entry", subject: "Test result batch entry" },
} as const satisfies Record<ClaimLane, { field: string; subject: string }>;

/**
 * The attempt's dimensions. WHAT was covered — requirement, role, behavior, risk, outcome — comes from
 * the matched test case; HOW it ran comes from the claim, via `attemptSurface` above. `declared.browser`
 * — the test case's own engine label — is validated (a test case missing it is malformed, exactly as
 * before) and then deliberately dropped on the floor: it is the value whose agreement with the
 * obligation used to manufacture credit for engines nothing ran. `declared.viewport` survives only as
 * lane 1's geometry, for the causal reason set out on `CoverageAttempt#viewport`; a lane-2 entry
 * reports its own and never borrows this one. `declared.accessibilityMethod` is dropped the same way as
 * the engine and for the same reason (CONTEXT.md:439): an attempt cannot address an Accessibility
 * Obligation at all, so the test case's declared method buys nothing and vetoes nothing. Each field is
 * copied by name rather than spread so that re-admitting any of them would have to be a visible,
 * deliberate edit.
 *
 * The diagnostic label is looked up from `lane` via `claimLanes` rather than taken as a separate
 * parameter: `lane` and its diagnostics are ONE fact, not two independently-suppliable ones, so a call
 * site cannot ask for one lane's derivation under another lane's messages.
 */
function dimensions(lane: ClaimLane, value: Readonly<Record<string, unknown>>, claim: Readonly<Record<string, unknown>>): CoverageDimensions {
  const { field } = claimLanes[lane];
  const coverage = value.coverage;
  if (!isRecord(coverage)) throw new QaSkillsError("Registered test case has no immutable coverage dimensions", "ARTIFACT_BINDING");
  // `executionSurface: "browser"` here is about the TEST CASE, not the attempt: `test-case.coverage` is
  // browser-shaped by schema, and reusing `asObligation` is how its declared engine and viewport get the
  // same validation an obligation's do. The attempt's own surface is decided by `attemptSurface` below
  // and overwrites this one field-by-field, so a test case can never talk a claim onto another surface.
  const declared = asObligation({ ...coverage, executionSurface: "browser", obligationId: "resolved", required: true });
  const surface = attemptSurface(lane, claim, field, declared.viewport);
  return {
    requirementId: declared.requirementId, executionSurface: surface.executionSurface, role: declared.role,
    behavior: declared.behavior, observedEngine: surface.observedEngine, viewport: surface.viewport,
    risk: declared.risk, outcome: declared.outcome,
  };
}

function requirementAuthority(artifacts: readonly RegisteredWorkspaceArtifact[], analysisId: string, requirementId: string): string {
  const analysis = artifacts.find((artifact) => artifact.record.id === analysisId && artifact.record.type === "requirement-analysis");
  const statements = analysis?.value.statements;
  if (!Array.isArray(statements)) throw new QaSkillsError("Coverage obligation references an orphan requirement analysis", "ARTIFACT_BINDING");
  const matches = statements.filter((statement): statement is RequirementStatement => isRecord(statement)
    && statement.requirementId === requirementId && typeof statement.authority === "string");
  if (matches.length !== 1) throw new QaSkillsError("Coverage obligation references an orphan or ambiguous requirement", "ARTIFACT_BINDING");
  return matches[0]?.authority ?? "";
}

/**
 * The obligation BYTES every registered Human Attestation attests to (CONTEXT.md:438). The join key
 * is the checksum, not `obligationId`: obligation ids are not unique across a workspace, and
 * `obligationSha256` is the byte-exact binding the artifact carries so a reader need not trust an id.
 *
 * The join is necessary but not sufficient. Credit additionally requires `creditsAttestation` — the
 * attestation sibling of the `creditsCoverage` gate every attempt below already passes through — so an
 * attestation payload that reached the workspace by any route other than `recordHumanAttestation`
 * carries `agent-draft` (registration's default) rather than `human-attestation:<identity>`, fails the
 * predicate, and credits nothing. That is what the schema's own `attestedBy` description already
 * asserts about the artifact, now actually enforced by a reader.
 *
 * This reader is the fail-CLOSED one and still does not throw on a checksum-less or wrongly-stamped
 * attestation, which is not a lapse: for every OTHER record it reads, malformed-means-drop would
 * silently GRANT credit the run did not earn, which is what it refuses to do. An attestation is the one
 * input where a drop can only ever WITHHOLD credit — already the closed direction — so there is nothing
 * to fail closed on. The schema requires the checksum regardless, and `readRegisteredArtifacts` above
 * has already rejected the whole workspace if any registered artifact failed it.
 */
function attestedObligationChecksums(artifacts: readonly RegisteredWorkspaceArtifact[]): ReadonlySet<string> {
  return new Set(artifacts
    .filter((artifact) => artifact.record.type === "human-attestation" && creditsAttestation(artifact.record.provenance))
    .map((artifact) => artifact.value.obligationSha256)
    .filter((checksum): checksum is string => typeof checksum === "string"));
}

function resolveObligation(artifacts: readonly RegisteredWorkspaceArtifact[], artifact: RegisteredWorkspaceArtifact, attested: ReadonlySet<string>): ResolvedCoverageObligation {
  const value = artifact.value;
  const obligation = asObligation(value);
  const analysisId = requireString(value.requirementAnalysisArtifactId, "coverage obligation requirement analysis artifact ID");
  return {
    ...obligation,
    authoritativeRequirement: requirementAuthority(artifacts, analysisId, obligation.requirementId) === "AUTHORITATIVE",
    humanAttested: attested.has(artifact.record.sha256),
  };
}

/** Resolves coverage from revalidated registered workspace records; caller strings only locate that workspace. */
export async function evaluateWorkspaceCoverage(options: { root: string; runId: string; /** Internal runtime seam for an already-locked active run. */ workspace?: RunWorkspace }): Promise<CoverageEvaluation> {
  const workspace = options.workspace ?? await RunWorkspace.open(options.root, options.runId);
  const ownsWorkspace = options.workspace === undefined;
  try {
    const artifacts = await workspace.readRegisteredArtifacts();
    const attested = attestedObligationChecksums(artifacts);
    const obligations = artifacts.filter((artifact) => artifact.record.type === "coverage-obligation").map((artifact) => resolveObligation(artifacts, artifact, attested));
    // `resolveDimensions` runs once per registered attempt and once per batch entry, so the test-case
    // scan it used to run is indexed once here. This function only reads (`artifacts` comes from the
    // single read above and nothing is registered before the try block ends), so the pool is invariant
    // for every consultation below.
    const casesByIdentity = indexByTestCaseIdentity(artifacts.filter((artifact) => artifact.record.type === "test-case"), (candidate) => ({ testCaseId: candidate.value.testCaseId, testCaseRevisionId: candidate.value.revisionId, testCaseInstanceId: candidate.value.instanceId }));
    /** The `lane` fixes both where the claim's surface and viewport come from and which diagnostics
     *  label its failures (see `claimLanes` above). */
    const resolveDimensions = (value: Readonly<Record<string, unknown>>, lane: ClaimLane): CoverageDimensions => {
      const { field, subject } = claimLanes[lane];
      const testCaseId = requireString(value.testCaseId, `${field} test case ID`);
      const revisionId = requireString(value.testCaseRevisionId, `${field} test case revision ID`);
      const instanceId = requireString(value.testCaseInstanceId, `${field} test case instance ID`);
      const matches = casesByIdentity.get({ testCaseId, testCaseRevisionId: revisionId, testCaseInstanceId: instanceId });
      if (matches.length !== 1) throw new QaSkillsError(`${subject} references an orphan or ambiguous test case revision and instance`, "ARTIFACT_BINDING");
      return dimensions(lane, matches[0]?.value ?? {}, value);
    };
    const attempts: CoverageAttempt[] = artifacts
      .filter((artifact) => artifact.record.type === "test-result" && creditsCoverage(artifact.record.provenance))
      .map((result) => ({
        attemptId: requireString(result.value.attemptId, "test result attempt ID"), status: requireString(result.value.status, "test result status"),
        ...resolveDimensions(result.value, "driven-attempt"),
      }));
    // Lane 2 (ADR-0010): one `test-result-batch` per Runtime-Observed Execution flattens into one
    // CoverageAttempt per entry, keyed by `entryId` (an entry has no attempt — no attempt was driven).
    // Crediting is gated by the SAME provenance predicate, so an agent-draft batch credits nothing.
    // The lane is fixed HERE, from the manifest record's type, and never sniffed off an entry's fields.
    const batchAttempts: CoverageAttempt[] = artifacts
      .filter((artifact) => artifact.record.type === "test-result-batch" && creditsCoverage(artifact.record.provenance))
      .flatMap((batch) => array(batch.value.entries).map((entry) => {
        if (!isRecord(entry)) throw new QaSkillsError("Registered test result batch entry is invalid", "ARTIFACT_BINDING");
        return {
          attemptId: requireString(entry.entryId, "test result batch entry ID"), status: requireString(entry.status, "test result batch entry status"),
          ...resolveDimensions(entry, "observed-entry"),
        };
      }));
    return evaluateCoverage(obligations, [...attempts, ...batchAttempts]);
  } finally {
    if (ownsWorkspace) await workspace.close();
  }
}

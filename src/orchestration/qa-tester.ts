import { createQaTester, type QaRuntimeRegistry, type QaWorkflowInput, type WorkflowResult } from "../operations/run-workflow.js";

export { createQaTester } from "../operations/run-workflow.js";
/**
 * Principle, sharpened over three review passes: export a type the consumer must CONSTRUCT to drive
 * the public API, but only when it has no name and would otherwise be UNWRITABLE. Do not export a type
 * the consumer only READS off a value the API already returned -- see `ArtifactType` below. Do not
 * export a type either, however constructed, when an inline object literal already satisfies it and
 * naming it would unlock nothing -- see `QaConfig` below. This is a closure rule, applied repeatedly:
 * once a type is exported because a consumer must build it AND could not otherwise write it, every type
 * one of its own fields forces the consumer to build under the same test is pulled in the same way, and
 * so on, until a pass finds nothing left to add.
 *
 * READ, not construct -- `ArtifactType` and `EvidenceCaptureType` are deliberately absent even though
 * `ArtifactRecord` (which carries them) is exported: a consumer only reads `record.type` /
 * `record.captureType` off a value the API returns, and `ArtifactRecord["type"]` /
 * `ArtifactRecord["captureType"]` name that without a separate export. `RunWorkspace` fails the same
 * test from the class side: it appears only in WorkflowOperationInputMap, which a consumer reads rather
 * than builds, so exporting it would lock its entire method surface into semver for no benefit.
 * `SecretReference` (the sole parameter of `SecretResolver`) is the same shape: a resolver only READS
 * `reference.secretRef` off a value the runtime constructs and hands it, never builds one.
 *
 * Construct, but a literal is enough -- `QaConfig` is deliberately absent even though
 * `TestDataHookRegistry.fromConfig`'s first parameter requires a consumer-built value: that parameter
 * is `Pick<QaConfig, "configDirectory" | "snapshot">`, two fields of type `string` and
 * `Record<string, unknown>`, and a consumer writes `{ configDirectory: "...", snapshot: {...} }`
 * in place with no import at all. Exporting `QaConfig` would additionally drag `configPath` -- a field
 * this call does not even accept -- into permanent semver, the exact "export locks an unused surface"
 * mistake `RunWorkspace` above avoids from the class side.
 *
 * Construct AND unwritable without a name -- everything below this line. `ExplorationAction` is the
 * element type of `ExplorationCharter.actions`, which a consumer builds to populate
 * `QaWorkflowInput.charter`. `EvidencePolicyLayer`, `EvidenceChannel`, `EvidenceMode`, and
 * `EvidenceRedactionPolicy` are the field types a consumer assembles into an `EvidencePolicyLayers`
 * value to populate `QaRuntimeRegistry.evidencePolicies`. `ExternalPermit` is the exact element type
 * `ExternalPermitRegistry`'s public constructor requires (`permits: readonly ExternalPermit[]`) --
 * exporting the class without it would leave a consumer unable to name the type of the array they are
 * required to build. `TestDataHookDescriptor` and `HookRunners` are `TestDataHookRegistry`'s two
 * constructor parameters (also `fromConfig`'s second parameter, unconditionally required) for the same
 * reason; `HookRunners`' own return type in turn requires `ProducedResource`, so it is pulled in too.
 * `TelemetryPayload` is what a consumer implementing `TelemetryScrubber` must RETURN -- producing a
 * return value is construction, the same as a parameter -- and `TelemetryPayload.findings` requires
 * `TelemetryFinding`. Each of those six was checked for further un-exported fields; all were plain
 * strings/numbers/literal unions, so the closure ends there -- no type below this comment still hides
 * an unnamed type a consumer must build.
 */
export type {
  QaRuntimeRegistry, QaWorkflowInput, WorkflowResult, WorkflowOutput, WorkflowTerminalStatus,
  WorkflowOperationInputMap, WorkflowOperationOutputMap, CorrelatedWorkflowOutputs,
  CanonicalPlanBundleRef, RegisteredArtifactRef, PendingHumanInput, PendingHumanInputSubject,
  PendingObservedExecution, RetestScenario, RetestSource,
} from "../operations/run-workflow.js";
export type { PublicWorkflowMode, WorkflowOperationName } from "../core/modes.js";
export type { WorkspaceValidation, WorkspaceDiagnostic, ArtifactRecord } from "../core/run-workspace.js";
export type { ReleaseRecommendation } from "../reporting/release-gate.js";
export type { ExplorationCharter, ExplorationAction } from "../exploratory/charter.js";
export type { SecretResolver, TelemetryFinding } from "../browser/types.js";
export type { EvidencePolicyLayers, EvidencePolicyLayer, EvidenceChannel, EvidenceMode, EvidenceRedactionPolicy } from "../evidence/policy.js";
export type { TelemetryScrubber, TelemetryPayload } from "../evidence/collector.js";
export { TestDataHookRegistry } from "../test-data/hooks.js";
export type { TestDataHookDescriptor, HookRunners, ProducedResource } from "../test-data/hooks.js";
export { ExternalPermitRegistry } from "../safety/external-permits.js";
export type { ExternalPermit } from "../safety/external-permits.js";
export { selectRegressionCases, regressionMappingSources } from "../regression/selector.js";
export type { ChangeScope, RegressionCase } from "../regression/change-scope.js";
export type { RegressionDecision, RegressionSelection, RegressionSource, UnmappedChangeRisk } from "../regression/selector.js";

/** Thin Skill Adapter boundary: it selects a runtime workflow and never shells one skill into another. */
export function qaTester(runtime: QaRuntimeRegistry, input: QaWorkflowInput): Promise<WorkflowResult> {
  return createQaTester(runtime)(input);
}

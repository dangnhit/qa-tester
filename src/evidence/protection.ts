import { isRecord } from "../core/values.js";

/** A profile-declared list of dom-selector redaction targets, coerced to a validated string[]. */
export function protectionDomSelectors(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

/** A profile-declared list of rectangular redaction regions, coerced to validated geometry. */
export function protectionRegions(value: unknown): readonly { x: number; y: number; width: number; height: number }[] {
  return Array.isArray(value) && value.every((item) => isRecord(item) && [item.x, item.y, item.width, item.height].every((part) => typeof part === "number"))
    ? value as { x: number; y: number; width: number; height: number }[] : [];
}

/**
 * The profile-SIDE protected-environment predicate: shared by the runtime capture policy
 * (`capturePolicyForEnvironment`) and the deterministic release gate
 * (`deriveReleaseGateFromWorkspaceArtifacts`) so both read protection from the Environment Profile
 * identically. An environment is protected when its profile classifies as `production`, explicitly
 * opts into `protected`, OR declares ANY redaction target (dom selector or region) — because no
 * archive channel can prove that target was masked (ADR-0009, CONTEXT.md redaction invariant).
 *
 * KNOWN LIMITATION (by design for the gate): this reads ONLY the persisted Environment Profile.
 * Protection contributed exclusively by the transient runtime `protection` host layer (never
 * persisted in the profile) is NOT reflected here; the runtime capture policy ORs that host layer
 * in separately. The release gate is a pure function of persisted artifacts, so its label reflects
 * exactly — and only — what the profile itself declares.
 */
export function profileDeclaresProtectedEnvironment(environment: Record<string, unknown>): boolean {
  const profile = isRecord(environment.evidenceProtection) ? environment.evidenceProtection : {};
  return environment.classification === "production"
    || profile.protected === true
    || protectionDomSelectors(profile.domSelectors).length > 0
    || protectionRegions(profile.regions).length > 0;
}

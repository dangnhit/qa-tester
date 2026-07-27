/**
 * The three lane values of `record.provenance` (CONTEXT.md:131-141, "Execution
 * Provenance" / "Runtime-Observed Execution"; docs/adr/0010-two-lane-execution-with-git-anchored-observation.md).
 * `runtime-execution` is lane 1 (the runtime drives the browser directly);
 * `runtime-observed` is lane 2 (the runtime spawns and observes an external
 * Playwright suite). `agent-draft` is a member of this union because it is a
 * legitimate provenance value the runtime records — but it is deliberately
 * NOT coverage-crediting: an agent-authored draft was never observed or
 * executed by the runtime, so it cannot stand in as evidence for a Coverage
 * Obligation. The manifest's `provenance` field also carries values outside
 * this union (`"runtime"`, `human-approval:*`, `runtime-import:*`, …); those
 * are not lane values and are intentionally not part of this type.
 */
export type ExecutionProvenance =
  | "runtime-execution"
  | "runtime-observed"
  | "agent-draft";

/** The single shared predicate for whether a provenance value may credit a Coverage Obligation. */
export function creditsCoverage(provenance?: string): boolean {
  return provenance === "runtime-execution" || provenance === "runtime-observed";
}

/** The `record.provenance` prefix `recordHumanAttestation` stamps; the suffix is the attester identity. */
export const humanAttestationProvenancePrefix = "human-attestation:";

/**
 * The single shared predicate for whether a provenance value may credit an Accessibility Obligation by
 * attestation — the attestation sibling of `creditsCoverage`, and gating the one remaining credit path
 * that had none.
 *
 * `human-attestation.schema.json`'s own `attestedBy` description already leans on this: "'Identified' …
 * is this field plus the manifest record's `human-attestation:<identity>` provenance, which no
 * agent-draft path can write." Only `recordHumanAttestation` (`qa-skill attestation record`) writes that
 * value; `RunWorkspace.registerArtifactValue` defaults an unstamped registration to `agent-draft`. So an
 * attestation payload that reached a workspace by any other route fails this predicate and credits
 * nothing, exactly as an `agent-draft` `test-result` credits nothing.
 *
 * The identity suffix must be non-empty: a bare `human-attestation:` names nobody, and an attestation by
 * nobody is not an identified person's claim. `recordHumanAttestation` rejects an empty attester before
 * it ever reaches registration, so this only ever fires on a record that did not come from it.
 */
export function creditsAttestation(provenance?: string): boolean {
  return provenance !== undefined
    && provenance.startsWith(humanAttestationProvenancePrefix)
    && provenance.length > humanAttestationProvenancePrefix.length;
}

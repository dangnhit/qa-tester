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

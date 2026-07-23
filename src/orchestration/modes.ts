import { QaSkillsError } from "../core/errors.js";

export const publicWorkflowModes = ["plan", "execute", "full", "exploratory", "retest", "regression"] as const;
export type PublicWorkflowMode = (typeof publicWorkflowModes)[number];

export const operationNames = [
  "ingest-requirement-analysis", "ingest-testcases", "ingest-coverage-obligation", "prepare-test-data", "execute-browser-test", "collect-evidence", "generate-bug-report", "generate-qa-report", "register-exploration-charter", "reproduce-bug", "select-regression", "derive-retest-verdict",
] as const;
export type WorkflowOperationName = (typeof operationNames)[number];

export type OperationMetadata = Readonly<{ name: WorkflowOperationName; dependsOn: readonly WorkflowOperationName[] }>;

const definitions: Readonly<Record<WorkflowOperationName, OperationMetadata>> = {
  "ingest-requirement-analysis": { name: "ingest-requirement-analysis", dependsOn: [] },
  "ingest-testcases": { name: "ingest-testcases", dependsOn: ["ingest-requirement-analysis"] },
  "ingest-coverage-obligation": { name: "ingest-coverage-obligation", dependsOn: ["ingest-requirement-analysis"] },
  "prepare-test-data": { name: "prepare-test-data", dependsOn: ["ingest-testcases"] },
  "execute-browser-test": { name: "execute-browser-test", dependsOn: [] },
  "collect-evidence": { name: "collect-evidence", dependsOn: [] },
  "generate-bug-report": { name: "generate-bug-report", dependsOn: ["collect-evidence"] },
  "generate-qa-report": { name: "generate-qa-report", dependsOn: ["collect-evidence"] },
  "register-exploration-charter": { name: "register-exploration-charter", dependsOn: [] },
  "reproduce-bug": { name: "reproduce-bug", dependsOn: [] },
  "select-regression": { name: "select-regression", dependsOn: [] },
  "derive-retest-verdict": { name: "derive-retest-verdict", dependsOn: ["reproduce-bug"] },
};

const directOperations: Readonly<Record<PublicWorkflowMode, readonly WorkflowOperationName[]>> = {
  plan: ["ingest-requirement-analysis", "ingest-testcases", "ingest-coverage-obligation"],
  execute: ["execute-browser-test", "collect-evidence"],
  full: ["ingest-requirement-analysis", "ingest-testcases", "ingest-coverage-obligation", "prepare-test-data", "execute-browser-test", "collect-evidence", "generate-bug-report", "generate-qa-report"],
  exploratory: ["register-exploration-charter", "collect-evidence", "generate-qa-report"],
  retest: ["reproduce-bug", "select-regression", "execute-browser-test", "collect-evidence", "generate-bug-report", "derive-retest-verdict"],
  regression: ["select-regression", "execute-browser-test", "collect-evidence", "generate-bug-report", "generate-qa-report"],
};

export function isPublicWorkflowMode(mode: string): mode is PublicWorkflowMode {
  return (publicWorkflowModes as readonly string[]).includes(mode);
}

/** Returns the exact public workflow order from explicit typed dependency metadata. */
export function operationsForMode(mode: PublicWorkflowMode): readonly WorkflowOperationName[] {
  if (!isPublicWorkflowMode(mode)) throw new QaSkillsError(`Unsupported public workflow mode: ${String(mode)}`, "INVALID_MODE");
  const requested = directOperations[mode];
  return resolveOperationOrder(requested, definitions);
}

/** Computes a deterministic transitive dependency closure for runtime metadata. */
export function resolveOperationOrder<T extends string>(requested: readonly T[], metadata: Readonly<Record<T, Readonly<{ dependsOn: readonly T[] }>>>): readonly T[] {
  const visiting = new Set<T>();
  const visited = new Set<T>();
  const ordered: T[] = [];
  const visit = (name: T): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new QaSkillsError("Workflow operation dependency cycle", "ARTIFACT_BINDING");
    visiting.add(name);
    for (const dependency of metadata[name].dependsOn) visit(dependency);
    visiting.delete(name); visited.add(name); ordered.push(name);
  };
  for (const name of requested) visit(name);
  return ordered;
}

export function operationMetadata(name: WorkflowOperationName): OperationMetadata {
  return definitions[name];
}

import { sha256Fingerprint, type TestCaseRevision } from "./testcase-revision.js";

export type BrowserMatrixMember = {
  browser?: string;
  viewport?: { width: number; height: number };
  [key: string]: unknown;
};

export type CoverageProfile = {
  parameterSets?: readonly Record<string, unknown>[];
  browserMatrix?: readonly BrowserMatrixMember[];
};

export type TestCaseInstance = {
  instanceId: string;
  testCaseId: string;
  revisionId: string;
  parameters: Record<string, unknown>;
  browser: BrowserMatrixMember | Record<string, never>;
};

function uniqueByFingerprint<T>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const fingerprint = sha256Fingerprint(item);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

export function expandTestCase(revision: TestCaseRevision, coverageProfile: CoverageProfile): TestCaseInstance[] {
  const parameterSets = uniqueByFingerprint(coverageProfile.parameterSets ?? [{}]);
  const browserMatrix = uniqueByFingerprint(coverageProfile.browserMatrix ?? [{}]);
  const instances = new Map<string, TestCaseInstance>();

  for (const parameters of parameterSets) {
    for (const browser of browserMatrix) {
      const fingerprint = sha256Fingerprint({ revisionId: revision.revisionId, parameters, browser });
      const instance: TestCaseInstance = {
        instanceId: `${revision.testCaseId}--${fingerprint.slice(0, 16)}`,
        testCaseId: revision.testCaseId,
        revisionId: revision.revisionId,
        parameters: { ...parameters },
        browser: { ...browser },
      };
      instances.set(instance.instanceId, instance);
    }
  }
  return [...instances.values()];
}

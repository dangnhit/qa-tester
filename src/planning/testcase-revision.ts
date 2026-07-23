import { createHash } from "node:crypto";

export type TestCaseExpectedResult = {
  id: string;
  requirementId: string;
  authority: string;
  text: string;
};

export type TestCaseStep = {
  id: string;
  action: string;
  sideEffect: string;
  cleanup?: { declared: boolean };
};

export type TestCaseCandidate = {
  testCaseId: string;
  title: string;
  expectedResults: readonly TestCaseExpectedResult[];
  steps: readonly TestCaseStep[];
  openQuestions?: readonly string[];
  dslValid?: boolean;
  [key: string]: unknown;
};

export type TestCaseRevision = Readonly<TestCaseCandidate> & {
  fingerprint: string;
  revisionId: string;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createTestCaseRevision(candidate: TestCaseCandidate): TestCaseRevision {
  const content = Object.fromEntries(
    Object.entries(candidate).filter(([key]) => key !== "fingerprint" && key !== "revisionId"),
  ) as TestCaseCandidate;
  const snapshot = canonicalize(content) as TestCaseCandidate;
  const fingerprint = sha256Fingerprint(snapshot);
  return { ...snapshot, fingerprint, revisionId: fingerprint };
}

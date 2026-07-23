import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";

import type { ExecutionStatus, SideEffectClass } from "../contracts/types.js";
import type { RegisteredWorkspaceArtifact, RunWorkspace } from "../core/run-workspace.js";

export type SecretReference = { secretRef: string };
export type SecretResolver = (reference: SecretReference) => Promise<string> | string;
export type StringValue = string | SecretReference;

export type LocatorDefinition = {
  role?: string;
  name?: string;
  testId?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  css?: string;
};

export type BrowserAction =
  | { kind: "open"; url: StringValue }
  | { kind: "click"; locator: LocatorDefinition }
  | { kind: "fill"; locator: LocatorDefinition; value: StringValue }
  | { kind: "select"; locator: LocatorDefinition; value: StringValue }
  | { kind: "check"; locator: LocatorDefinition }
  | { kind: "uncheck"; locator: LocatorDefinition }
  | { kind: "press"; locator: LocatorDefinition; key: string }
  | { kind: "upload"; locator: LocatorDefinition; files: string[] }
  | { kind: "wait"; milliseconds?: number; locator?: LocatorDefinition };

export type BrowserAssertion =
  | { kind: "visible"; locator: LocatorDefinition }
  | { kind: "text"; locator: LocatorDefinition; text: string }
  | { kind: "value"; locator: LocatorDefinition; value: StringValue }
  | { kind: "url"; url: string }
  | { kind: "count"; locator: LocatorDefinition; count: number }
  | { kind: "enabled"; locator: LocatorDefinition }
  | { kind: "disabled"; locator: LocatorDefinition }
  | { kind: "checked"; locator: LocatorDefinition }
  | { kind: "response-status"; url: string; status: number }
  | { kind: "console-policy"; level?: "error" | "warning"; allow?: string[] }
  | { kind: "network-policy"; allow?: string[] };

export type BrowserTestStep = {
  id: string;
  action: BrowserAction;
  assertions?: readonly BrowserAssertion[];
  sideEffect: SideEffectClass;
  independent?: boolean;
};

export type BrowserTestInstance = {
  testCaseId: string;
  revisionId: string;
  instanceId: string;
  title?: string;
  browser?: { viewport?: { width: number; height: number } };
};

export type TelemetryFinding = {
  kind: "console" | "network" | "navigation-cancelled";
  message: string;
  url?: string;
  status?: number;
  level?: string;
  timestamp: string;
};

export type BrowserTelemetry = {
  findings: TelemetryFinding[];
  responseStatuses: Map<string, number[]>;
};

export type BrowserStepResult = {
  stepId: string;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  action: BrowserAction;
  assertions: readonly BrowserAssertion[];
  error?: string;
};

export type TestAttempt = {
  attemptId: string;
  runId: string;
  testCaseId: string;
  testCaseRevisionId: string;
  testCaseInstanceId: string;
  contextId: string;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt: string;
  steps: readonly BrowserStepResult[];
  telemetry: readonly TelemetryFinding[];
};

export type ActiveBrowserSession = {
  context: BrowserContext;
  page: Page;
  telemetry: BrowserTelemetry;
};

type RawExecuteTestInput = {
  browser: Browser;
  runId: string;
  testCase: BrowserTestInstance;
  steps: readonly BrowserTestStep[];
  resolveSecret?: SecretResolver;
};

export type ExecuteTestInput = {
  workspace: RunWorkspace;
  browser: Browser;
  attemptId: string;
  testCaseArtifactId: string;
  resolveSecret?: SecretResolver;
  onSessionActive?: (input: { attemptId: string; session: ActiveBrowserSession }) => Promise<void> | void;
};

export type CanonicalBrowserTestCase = BrowserTestInstance & {
  browserDsl: { steps: readonly BrowserTestStep[] };
  artifact: RegisteredWorkspaceArtifact;
};
export type InternalExecuteTestInput = RawExecuteTestInput & { attemptId: string; onSessionActive?: ExecuteTestInput["onSessionActive"] };

export type ResolvedLocator = Locator;

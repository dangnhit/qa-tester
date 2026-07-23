import type { QARunMetadata } from "../../src/contracts/generated/run-metadata.js";

const base = {
  artifactType: "run-metadata",
  schemaVersion: "1.0.0",
  producerVersion: "1.0.0",
  runId: "20260723T123456Z-a1b2c3",
  createdAt: "2026-07-23T12:34:56.000Z",
  environmentProfileId: "env-test",
} as const;

const active: QARunMetadata = { ...base, status: "RUNNING", mode: "execute" };

const terminal: QARunMetadata = {
  ...base,
  status: "COMPLETED",
  mode: "full",
  finalizedProfile: { name: "full", version: "1.0.0" },
};

void active;
void terminal;

// @ts-expect-error Active metadata must forbid finalizedProfile.
const activeWithProfile: QARunMetadata = { ...base, status: "RUNNING", mode: "execute", finalizedProfile: { name: "execute", version: "1.0.0" } };

// @ts-expect-error Terminal metadata must require finalizedProfile.
const terminalWithoutProfile: QARunMetadata = { ...base, status: "BLOCKED", mode: "execute" };

// @ts-expect-error The finalized profile name must exactly match mode.
const terminalWithWrongMode: QARunMetadata = { ...terminal, finalizedProfile: { name: "plan", version: "1.0.0" } };

// @ts-expect-error Canonical metadata is closed to additional properties.
const terminalWithExtraProperty: QARunMetadata = { ...terminal, unexpected: true };

void activeWithProfile;
void terminalWithoutProfile;
void terminalWithWrongMode;
void terminalWithExtraProperty;

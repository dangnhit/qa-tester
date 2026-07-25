import { describe, expect, it } from "vitest";

import { capturePolicyForEnvironment } from "../../src/operations/run-workflow.js";

const baseEnvironment = {
  artifactType: "environment-profile",
  schemaVersion: "1.0.0",
  producerVersion: "1.0.0",
  environmentProfileId: "ENV-CAPTURE",
  name: "Capture fixture",
  classification: "test",
  baseUrl: "http://127.0.0.1",
  productionReadOnly: false,
} as const;

describe("capturePolicyForEnvironment", () => {
  it("treats trace retention as off unless the profile opts in", () => {
    expect(capturePolicyForEnvironment({ ...baseEnvironment }, {}).retainTrace).toBe(false);
    expect(capturePolicyForEnvironment({ ...baseEnvironment, evidenceProtection: {} }, {}).retainTrace).toBe(false);
    expect(capturePolicyForEnvironment({ ...baseEnvironment, evidenceProtection: { retainTrace: false } }, {}).retainTrace).toBe(false);
  });

  it("surfaces the profile retainTrace permission into the capture policy", () => {
    expect(capturePolicyForEnvironment({ ...baseEnvironment, evidenceProtection: { retainTrace: true } }, {}).retainTrace).toBe(true);
  });

  it("does not treat a clean non-production environment as protected", () => {
    expect(capturePolicyForEnvironment({ ...baseEnvironment }, {}).protectedEnvironment).toBe(false);
    expect(capturePolicyForEnvironment({ ...baseEnvironment, evidenceProtection: { retainTrace: true } }, {}).protectedEnvironment).toBe(false);
  });

  it("keeps the existing protected triggers (production, explicit protected, runtime protection)", () => {
    expect(capturePolicyForEnvironment({ ...baseEnvironment, classification: "production" }, {}).protectedEnvironment).toBe(true);
    expect(capturePolicyForEnvironment({ ...baseEnvironment, evidenceProtection: { protected: true } }, {}).protectedEnvironment).toBe(true);
    expect(capturePolicyForEnvironment({ ...baseEnvironment }, { protection: { protectedEnvironment: true } }).protectedEnvironment).toBe(true);
  });

  it("makes declaring a dom-selector redaction target on the profile imply a protected environment", () => {
    const policy = capturePolicyForEnvironment({ ...baseEnvironment, evidenceProtection: { domSelectors: ["input#ssn"] } }, {});
    expect(policy.protectedEnvironment).toBe(true);
    expect(policy.redaction.domSelectors).toContain("input#ssn");
  });

  it("makes declaring a region redaction target on the runtime layer imply a protected environment", () => {
    const policy = capturePolicyForEnvironment({ ...baseEnvironment }, { protection: { regions: [{ x: 0, y: 0, width: 10, height: 10 }] } });
    expect(policy.protectedEnvironment).toBe(true);
    expect(policy.redaction.regions).toHaveLength(1);
  });
});

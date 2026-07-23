import { describe, expect, it } from "vitest";

import { ExternalPermitRegistry } from "../../src/safety/external-permits.js";
import { authorizeStep } from "../../src/safety/side-effects.js";

const production = { classification: "production" as const, productionReadOnly: true };
const staging = { classification: "staging" as const, productionReadOnly: false };

describe("side-effect policy", () => {
  it("denies production by default and only allows explicit read-only none steps", async () => {
    await expect(authorizeStep({ sideEffect: "none", action: "navigate" }, { ...production, productionReadOnly: false }, [])).resolves.toMatchObject({ allowed: false });
    await expect(authorizeStep({ sideEffect: "none", action: "navigate" }, production, [])).resolves.toMatchObject({ allowed: true });
    await expect(authorizeStep({ sideEffect: "reversible", action: "fill" }, production, [])).resolves.toMatchObject({ allowed: false });
  });

  it("requires exact, source-attributed permits and always rejects payment/destructive actions", async () => {
    const registry = new ExternalPermitRegistry([{ permitId: "permit-1", source: "change-123", channel: "email", action: "send", environment: "staging", target: "test@example.test", expiresAt: "2030-01-01T00:00:00.000Z", maxUses: 1 }]);
    const step = { sideEffect: "external" as const, action: "send", channel: "email", target: "test@example.test" };
    await expect(authorizeStep(step, staging, registry)).resolves.toMatchObject({ allowed: true });
    await expect(authorizeStep(step, staging, registry)).resolves.toMatchObject({ allowed: false });
    const race = new ExternalPermitRegistry([{ permitId: "race", source: "change-123", channel: "email", action: "send", environment: "staging", target: "race@example.test", expiresAt: "2030-01-01T00:00:00.000Z", maxUses: 1 }]);
    const raced = await Promise.all([authorizeStep({ ...step, target: "race@example.test" }, staging, race), authorizeStep({ ...step, target: "race@example.test" }, staging, race)]);
    expect(raced.filter((decision) => decision.allowed)).toHaveLength(1);
    await expect(authorizeStep({ sideEffect: "external", action: "charge-card", channel: "payment", target: "test@example.test" }, staging, registry)).resolves.toMatchObject({ allowed: false });
    await expect(authorizeStep({ sideEffect: "destructive", action: "delete", channel: "internal", target: "resource-1" }, staging, registry)).resolves.toMatchObject({ allowed: false });
    expect(() => new ExternalPermitRegistry([{ permitId: "wild", source: "x", channel: "email", action: "send", environment: "staging", target: "*", expiresAt: "2030-01-01T00:00:00.000Z", maxUses: 1 }])).toThrow(/wildcard/i);
  });

  it("does not consume invalid, expired, or mismatched permits", async () => {
    const permit = { permitId: "exact", source: "approved-change", channel: "sms", action: "send", environment: "staging", target: "qa@example.test", expiresAt: "2030-01-01T00:00:00.000Z", maxUses: 1 };
    const registry = new ExternalPermitRegistry([permit], () => new Date("2029-01-01T00:00:00.000Z"));
    for (const step of [
      { sideEffect: "external" as const, channel: "email", action: "send", target: permit.target },
      { sideEffect: "external" as const, channel: permit.channel, action: "other", target: permit.target },
      { sideEffect: "external" as const, channel: permit.channel, action: permit.action, target: "other@example.test" },
    ]) await expect(authorizeStep(step, staging, registry)).resolves.toMatchObject({ allowed: false });
    await expect(authorizeStep({ sideEffect: "external", channel: permit.channel, action: permit.action, target: permit.target }, staging, registry)).resolves.toMatchObject({ allowed: true });
    const expired = new ExternalPermitRegistry([{ ...permit, permitId: "expired", expiresAt: "2020-01-01T00:00:00.000Z" }]);
    await expect(authorizeStep({ sideEffect: "external", channel: permit.channel, action: permit.action, target: permit.target }, staging, expired)).resolves.toMatchObject({ allowed: false });
    await expect(authorizeStep({ sideEffect: "external", channel: permit.channel, action: permit.action, target: permit.target }, { ...staging, classification: "test" }, new ExternalPermitRegistry([permit]))).resolves.toMatchObject({ allowed: false });
    expect(() => new ExternalPermitRegistry([{ ...permit, source: "" }])).toThrow(/source/i);
  });
});

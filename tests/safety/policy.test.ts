import { describe, expect, it } from "vitest";

import { ExternalPermitRegistry } from "../../src/safety/external-permits.js";
import { authorizeStep } from "../../src/safety/side-effects.js";

const production = { classification: "production" as const, productionReadOnly: true };
const staging = { classification: "staging" as const, productionReadOnly: false };

describe("side-effect policy", () => {
  it("denies production by default and only allows explicit read-only none steps", () => {
    expect(authorizeStep({ sideEffect: "none", action: "navigate" }, { ...production, productionReadOnly: false }, [])).toMatchObject({ allowed: false });
    expect(authorizeStep({ sideEffect: "none", action: "navigate" }, production, [])).toMatchObject({ allowed: true });
    expect(authorizeStep({ sideEffect: "reversible", action: "fill" }, production, [])).toMatchObject({ allowed: false });
  });

  it("requires exact, source-attributed permits and always rejects payment/destructive actions", async () => {
    const registry = new ExternalPermitRegistry([{ permitId: "permit-1", source: "change-123", channel: "email", action: "send", environment: "staging", target: "test@example.test", expiresAt: "2030-01-01T00:00:00.000Z", maxUses: 1 }]);
    const step = { sideEffect: "external" as const, action: "send", channel: "email", target: "test@example.test" };
    expect(authorizeStep(step, staging, registry)).toMatchObject({ allowed: true });
    expect(await registry.consume(step, staging)).toMatchObject({ allowed: true });
    expect(await registry.consume(step, staging)).toMatchObject({ allowed: false });
    const race = new ExternalPermitRegistry([{ permitId: "race", source: "change-123", channel: "email", action: "send", environment: "staging", target: "race@example.test", expiresAt: "2030-01-01T00:00:00.000Z", maxUses: 1 }]);
    const raced = await Promise.all([race.consume({ ...step, target: "race@example.test" }, staging), race.consume({ ...step, target: "race@example.test" }, staging)]);
    expect(raced.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(authorizeStep({ sideEffect: "external", action: "charge-card", channel: "payment", target: "test@example.test" }, staging, registry)).toMatchObject({ allowed: false });
    expect(authorizeStep({ sideEffect: "destructive", action: "delete", channel: "internal", target: "resource-1" }, staging, registry)).toMatchObject({ allowed: false });
    expect(() => new ExternalPermitRegistry([{ permitId: "wild", source: "x", channel: "email", action: "send", environment: "staging", target: "*", expiresAt: "2030-01-01T00:00:00.000Z", maxUses: 1 }])).toThrow(/wildcard/i);
  });
});

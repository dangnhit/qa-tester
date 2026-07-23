import type { SideEffectClass } from "../contracts/types.js";
import { ExternalPermitRegistry, type ExternalStep } from "./external-permits.js";

export type SafetyEnvironment = Readonly<{ classification: "local" | "test" | "staging" | "production"; productionReadOnly: boolean }>;
export type SafetyStep = Readonly<{ sideEffect: SideEffectClass; action: string; channel?: string; target?: string }>;
export type SafetyDecision = Readonly<{ allowed: boolean; reasons: readonly string[]; permitId?: string }>;

const payment = /(?:payment|charge|refund|card|wallet)/i;
export async function authorizeStep(step: SafetyStep, environment: SafetyEnvironment, permits: readonly unknown[] | ExternalPermitRegistry): Promise<SafetyDecision> {
  if (step.sideEffect === "destructive") return { allowed: false, reasons: ["destructive-actions-are-denied"] };
  if (payment.test(step.action) || payment.test(step.channel ?? "")) return { allowed: false, reasons: ["real-payment-actions-are-denied"] };
  if (environment.classification === "production") {
    if (!environment.productionReadOnly) return { allowed: false, reasons: ["production-requires-explicit-read-only-opt-in"] };
    return step.sideEffect === "none" ? { allowed: true, reasons: [] } : { allowed: false, reasons: ["production-allows-only-none-side-effects"] };
  }
  if (step.sideEffect !== "external") return { allowed: true, reasons: [] };
  if (!(permits instanceof ExternalPermitRegistry) || !step.channel || !step.target) return { allowed: false, reasons: ["external-action-requires-exact-permit"] };
  const decision = await permits.authorizeAndConsume(step as ExternalStep, environment);
  return decision.allowed
    ? { allowed: true, reasons: [], ...(decision.permitId === undefined ? {} : { permitId: decision.permitId }) }
    : { allowed: false, reasons: [decision.reason ?? "external-action-denied"] };
}

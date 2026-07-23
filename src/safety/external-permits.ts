export type ExternalPermit = Readonly<{ permitId: string; source: string; channel: string; action: string; environment: string; target: string; expiresAt: string; maxUses: number }>;
export type ExternalStep = Readonly<{ sideEffect: "external"; action: string; channel?: string; target?: string }>;
export type PermitEnvironment = Readonly<{ classification: string }>;
export type PermitDecision = Readonly<{ allowed: boolean; reason?: string; permitId?: string }>;

function invalid(value: string): boolean { return value.length === 0 || value.includes("*"); }
function validate(permit: ExternalPermit): void {
  if ([permit.permitId, permit.source, permit.channel, permit.action, permit.environment, permit.target].some(invalid)) throw new Error("External permits require exact non-wildcard source-attributed scope");
  if (!Number.isSafeInteger(permit.maxUses) || permit.maxUses < 1 || Number.isNaN(Date.parse(permit.expiresAt))) throw new Error("External permit expiry and use limit are invalid");
}
function matches(permit: ExternalPermit, step: ExternalStep, environment: PermitEnvironment, now: Date): boolean {
  return permit.channel === step.channel && permit.action === step.action && permit.environment === environment.classification && permit.target === step.target && Date.parse(permit.expiresAt) > now.getTime();
}

export class ExternalPermitRegistry {
  private readonly permits: readonly ExternalPermit[];
  private readonly consumed = new Map<string, number>();
  private tail: Promise<void> = Promise.resolve();
  public constructor(permits: readonly ExternalPermit[], private readonly clock: () => Date = () => new Date()) {
    permits.forEach(validate);
    this.permits = Object.freeze(permits.map((permit) => Object.freeze({ ...permit })));
  }
  private available(step: ExternalStep, environment: PermitEnvironment): PermitDecision {
    const permit = this.permits.find((candidate) => matches(candidate, step, environment, this.clock()) && (this.consumed.get(candidate.permitId) ?? 0) < candidate.maxUses);
    return permit ? { allowed: true, permitId: permit.permitId } : { allowed: false, reason: "missing-or-exhausted-external-permit" };
  }
  /** The only permit decision exposed to action callers; successful authorization consumes one use atomically. */
  public authorizeAndConsume(step: ExternalStep, environment: PermitEnvironment): Promise<PermitDecision> {
    const operation = this.tail.then(() => {
      const decision = this.available(step, environment);
      if (decision.allowed && decision.permitId) this.consumed.set(decision.permitId, (this.consumed.get(decision.permitId) ?? 0) + 1);
      return decision;
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

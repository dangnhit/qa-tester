export type ReproductionAttempt = Readonly<{ attemptId: string; status: string; failureClassification: string }>;
export type ReproductionOutcome = "REPRODUCED" | "NOT_REPRODUCED" | "INTERMITTENT" | "RERUN_OMITTED_UNSAFE";
export type ReproductionResult = Readonly<{
  attemptIds: readonly string[];
  attempted: number;
  total: number;
  rate: string;
  outcome: ReproductionOutcome;
  unsafeRerunReason?: string;
}>;

function isProductFailure(attempt: ReproductionAttempt): boolean {
  return attempt.status === "FAILED" && attempt.failureClassification === "PRODUCT_DEFECT";
}

/** Evaluates explicit immutable attempts. It never performs or disguises a retry. */
export function evaluateReproduction(attempts: readonly ReproductionAttempt[], options: Readonly<{ unsafeRerunReason?: string }> = {}): ReproductionResult {
  if (attempts.length === 0) throw new Error("A reproduction set requires the original attempt");
  if (new Set(attempts.map((attempt) => attempt.attemptId)).size !== attempts.length) throw new Error("A reproduction set requires distinct attempts");
  if (attempts.length === 1 && !options.unsafeRerunReason) throw new Error("A normal reproduction set requires two total attempts or an unsafe rerun reason");
  const failures = attempts.filter(isProductFailure).length;
  const attempted = attempts.length;
  const total = attempted === 1 ? 2 : attempted;
  const outcome: ReproductionOutcome = attempted === 1
    ? "RERUN_OMITTED_UNSAFE"
    : failures === attempted ? "REPRODUCED"
      : failures === 0 ? "NOT_REPRODUCED"
        : "INTERMITTENT";
  return {
    attemptIds: attempts.map((attempt) => attempt.attemptId), attempted, total, rate: `${failures}/${total}`, outcome,
    ...(outcome === "RERUN_OMITTED_UNSAFE" ? { unsafeRerunReason: options.unsafeRerunReason } : {}),
  };
}

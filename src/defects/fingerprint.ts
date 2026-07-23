import { createHash } from "node:crypto";

export type FingerprintInput = Readonly<{ feature: string; expected: string; actual: string; affectedAreas: readonly string[] }>;
export type FingerprintRegistration =
  | Readonly<{ kind: "NEW" }>
  | Readonly<{ kind: "CONSOLIDATED"; canonicalBugId: string }>
  | Readonly<{ kind: "POSSIBLE_DUPLICATE"; possibleDuplicateBugIds: readonly string[] }>;

function normalize(value: string): string { return value.trim().replace(/\s+/g, " ").toLowerCase(); }

export function createBugFingerprint(input: FingerprintInput): string {
  const canonical = JSON.stringify({
    feature: normalize(input.feature), expected: normalize(input.expected), actual: normalize(input.actual),
    affectedAreas: [...input.affectedAreas].map(normalize).sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function createRunScopedBugId(feature: string, runId: string, ordinal: number): string {
  const suffix = runId.match(/-([0-9a-f]{6})$/i)?.[1];
  if (!suffix || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > 999) throw new Error("Bug ID requires a run suffix and ordinal from 1 to 999");
  const normalizedFeature = feature.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!normalizedFeature) throw new Error("Bug ID requires a feature");
  return `BUG-${normalizedFeature}-${suffix.toUpperCase()}-${String(ordinal).padStart(3, "0")}`;
}

/** Run-local equality is consolidation; cross-run equality remains only a suggestion. */
export class BugFingerprintRegistry {
  private readonly observations: { runId: string; bugId: string; fingerprint: string }[] = [];

  register(input: Readonly<{ runId: string; bugId: string; fingerprint: string }>): FingerprintRegistration {
    const sameRun = this.observations.find((item) => item.runId === input.runId && item.fingerprint === input.fingerprint);
    if (sameRun) return { kind: "CONSOLIDATED", canonicalBugId: sameRun.bugId };
    const crossRun = this.observations.filter((item) => item.runId !== input.runId && item.fingerprint === input.fingerprint).map((item) => item.bugId);
    this.observations.push({ ...input });
    return crossRun.length === 0 ? { kind: "NEW" } : { kind: "POSSIBLE_DUPLICATE", possibleDuplicateBugIds: crossRun };
  }
}

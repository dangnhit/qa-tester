export const requirementAuthorities = ["AUTHORITATIVE", "INFERRED", "ASSUMED", "CONFLICTING"] as const;
export type RequirementAuthority = (typeof requirementAuthorities)[number];

export type UserStatementInput = {
  text: string;
  source?: "user" | "code" | "documentation" | "agent";
  conflictsWith?: readonly { text: string; authority: RequirementAuthority }[];
};

type RequirementStatement = {
  requirementId: string;
  normalizedText: string;
  authority: RequirementAuthority;
  sourceProvenance: { kind: "user" | "code" | "documentation" | "agent" };
  conflictsWith?: readonly { text: string; authority: RequirementAuthority }[];
};

const tentativeLanguage = /\b(may|might|could|perhaps|probably|guess|think|assume|tentative)\b/i;
const explicitExpectation = /\b(must|shall|required|expected|should|need(?:s)? to)\b/i;

export function classifyUserStatement(input: UserStatementInput | string): RequirementAuthority {
  const statement = typeof input === "string" ? { text: input, source: "user" as const } : input;
  if (statement.conflictsWith?.some((conflict) => conflict.authority === "AUTHORITATIVE")) {
    return "CONFLICTING";
  }
  if (statement.source === "code") return "INFERRED";
  if (tentativeLanguage.test(statement.text)) return "ASSUMED";
  return explicitExpectation.test(statement.text) ? "AUTHORITATIVE" : "ASSUMED";
}

export function isRequirementAuthority(value: unknown): value is RequirementAuthority {
  return typeof value === "string" && (requirementAuthorities as readonly string[]).includes(value);
}

export function derivedRequirementAuthority(statement: RequirementStatement): RequirementAuthority {
  return classifyUserStatement({
    text: statement.normalizedText,
    source: statement.sourceProvenance.kind,
    ...(statement.conflictsWith ? { conflictsWith: statement.conflictsWith } : {}),
  });
}

export function assertRequirementAuthorities(value: unknown): void {
  if (typeof value !== "object" || value === null || !Array.isArray((value as Record<string, unknown>).statements)) {
    throw new Error("Requirement analysis statements are required for authority verification");
  }
  for (const statement of (value as { statements: RequirementStatement[] }).statements) {
    const derived = derivedRequirementAuthority(statement);
    if (statement.authority !== derived) {
      throw new Error(`Requirement authority ${statement.authority} disagrees with provenance-derived ${derived}`);
    }
  }
}

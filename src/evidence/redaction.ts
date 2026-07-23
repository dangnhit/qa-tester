export type CssBox = { x: number; y: number; width: number; height: number };
export type RedactionPlan = { protectedEnvironment: boolean; domSelectors: readonly string[]; regions: readonly CssBox[] };
export type EvidenceGap = { artifactType: "evidence-gap"; schemaVersion: "1.0.0"; producerVersion: string; evidenceGapId: string; runId: string; attemptId: string; reason: string; affectedClaim: string };
export type RedactionCheck = { safe: true } | { safe: false; gap: EvidenceGap };
export type NetworkRecord = { url: string; requestHeaders?: Record<string, string>; responseHeaders?: Record<string, string>; requestBody?: string; responseBody?: string };

const sensitiveKey = /(?:authorization|proxy-authorization|cookie|set-cookie|password|passcode|secret|token|api[-_]?key|credential)/i;

function gap(reason: string, affectedClaim: string): EvidenceGap {
  return { artifactType: "evidence-gap", schemaVersion: "1.0.0", producerVersion: "0.1.0", evidenceGapId: "unknown", runId: "unknown", attemptId: "unknown", reason, affectedClaim };
}

function validBox(box: CssBox): boolean {
  return Number.isFinite(box.x) && Number.isFinite(box.y) && Number.isFinite(box.width) && Number.isFinite(box.height) && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0;
}

/** Performs static checks before capture. Browser selector validation happens before taking a screenshot. */
export function validateRedactionPlan(plan: RedactionPlan): RedactionCheck {
  if (!plan.protectedEnvironment) return { safe: true };
  if (plan.domSelectors.some((selector) => selector.trim() === "" || selector.includes("[") !== selector.includes("]"))) {
    return { safe: false, gap: gap("Configured redaction selector is invalid", "screenshot capture") };
  }
  if (plan.regions.some((region) => !validBox(region))) return { safe: false, gap: gap("Configured redaction region is invalid", "screenshot capture") };
  return { safe: true };
}

export function redactText(value: string, secrets: readonly string[]): string {
  return secrets.filter((secret) => secret.length > 0).reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value);
}

function redactJson(value: unknown, secrets: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => redactJson(item, secrets));
  if (typeof value !== "object" || value === null) return typeof value === "string" ? redactText(value, secrets) : value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : redactJson(item, secrets)]));
}

function redactBody(body: string, secrets: readonly string[]): string {
  const text = redactText(body, secrets);
  try { return JSON.stringify(redactJson(JSON.parse(text), secrets)); } catch {
    return text.replace(/((?:^|[&;,\s])(?:password|passcode|secret|token|api[-_]?key|credential)\s*[=:]\s*)([^&;,\s]*)/gi, "$1[REDACTED]");
  }
}

function redactHeaders(headers: Record<string, string>, secrets: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : redactText(value, secrets)]));
}

/** Scrubs headers and bodies before the caller is allowed to persist network telemetry. */
export function redactNetworkRecord(record: NetworkRecord, secrets: readonly string[]): NetworkRecord {
  return {
    url: redactText(record.url, secrets),
    ...(record.requestHeaders === undefined ? {} : { requestHeaders: redactHeaders(record.requestHeaders, secrets) }),
    ...(record.responseHeaders === undefined ? {} : { responseHeaders: redactHeaders(record.responseHeaders, secrets) }),
    ...(record.requestBody === undefined ? {} : { requestBody: redactBody(record.requestBody, secrets) }),
    ...(record.responseBody === undefined ? {} : { responseBody: redactBody(record.responseBody, secrets) }),
  };
}

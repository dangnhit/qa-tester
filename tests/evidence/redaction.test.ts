import { describe, expect, it } from "vitest";

import { redactNetworkRecord, redactText, validateRedactionPlan } from "../../src/evidence/redaction.js";

describe("evidence redaction", () => {
  it("scrubs exact secret values and sensitive request fields before persistence", () => {
    const record = redactNetworkRecord({
      url: "https://example.test/api?token=super-secret",
      requestHeaders: { Authorization: "Bearer super-secret", "X-Trace": "safe" },
      responseHeaders: { "Set-Cookie": "session=super-secret", "Content-Type": "application/json" },
      requestBody: '{"password":"super-secret","name":"Ada"}',
      responseBody: '{"access_token":"super-secret","email":"ada@example.test"}',
    }, ["super-secret"]);

    expect(JSON.stringify(record)).not.toContain("super-secret");
    expect(record.requestHeaders).toEqual({ Authorization: "[REDACTED]", "X-Trace": "safe" });
    expect(record.requestBody).toContain('"password":"[REDACTED]"');
    expect(record.responseBody).toContain('"access_token":"[REDACTED]"');
  });

  it("returns a governed gap when configured masking cannot be safely applied", () => {
    expect(validateRedactionPlan({ protectedEnvironment: true, domSelectors: ["["], regions: [] })).toEqual({
      safe: false,
      gap: expect.objectContaining({ reason: expect.stringMatching(/redaction/i), affectedClaim: "screenshot capture" }),
    });
  });

  it("scrubs structured secret values without relying on a secret name", () => {
    expect(redactText("credential=abc123", ["abc123"])).toBe("credential=[REDACTED]");
  });

  it("scrubs percent-encoded and form-normalized browser variants of secrets", () => {
    const secret = "private email+token@example.test";
    const encoded = encodeURIComponent(secret);
    const formEncoded = encoded.replaceAll("%20", "+");
    expect(redactText(`raw=${secret}&encoded=${encoded}&form=${formEncoded}`, [secret]))
      .toBe("raw=[REDACTED]&encoded=[REDACTED]&form=[REDACTED]");
  });

  it("scrubs sensitive form-body fields before persistence", () => {
    expect(redactNetworkRecord({ url: "https://example.test", requestBody: "email=ada%40example.test&password=unknown-value" }, []).requestBody)
      .toBe("email=ada%40example.test&password=[REDACTED]");
  });
});

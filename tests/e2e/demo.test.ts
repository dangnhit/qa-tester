import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDemo } from "../../scripts/run-demo.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}
describe("localhost intentional-failure demo", () => {
  it("detects the product defect on Chromium desktop and mobile and validates the full artifact profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-skills-demo-"));
    roots.push(root);

    const result = await runDemo({ root });
    const [desktop, mobile] = result.attempts;

    expect(result.run.status).toBe("COMPLETED_WITH_FAILURES");
    expect(result.attempts).toHaveLength(2);
    expect(desktop?.status).toBe("FAILED");
    expect(desktop?.classification).toBe("PRODUCT_DEFECT");
    expect(desktop?.instanceId).toBe("INSTANCE-DEMO-DESKTOP");
    expect(mobile?.status).toBe("FAILED");
    expect(mobile?.classification).toBe("PRODUCT_DEFECT");
    expect(mobile?.instanceId).toBe("INSTANCE-DEMO-MOBILE");
    expect(result.files).toContainEqual(expect.stringMatching(/screenshots\/raw\/.*\.png$/));
    expect(result.files).toContainEqual(expect.stringMatching(/screenshots\/annotated\/.*\.png$/));
    expect(result.files).toContainEqual(expect.stringMatching(/traces\/.*\.zip$/));
    expect(result.report.releaseRecommendation).toBe("NOT_READY");
    expect(result.validation.valid).toBe(true);
    expect(result.telemetry.consoleErrors).toContain("QA_DEMO_CONSOLE_ERROR");
    expect(result.telemetry.failedRequests).toContain("/api/demo-failure");
    expect(result.cleanup).toEqual({ status: "COMPLETED", resources: ["deleted"] });
    for (const instanceId of ["INSTANCE-DEMO-DESKTOP", "INSTANCE-DEMO-MOBILE"]) {
      const evidence = result.evidenceByInstance.find((item) => item.instanceId === instanceId);
      expect(evidence).toMatchObject({
        instanceId,
        rawScreenshots: 1,
        annotatedScreenshots: 1,
        traces: 1,
        console: 1,
        network: 1,
        annotation: {
          testCaseRevisionId: "REV-DEMO-SAVE",
          testCaseInstanceId: instanceId,
          locator: JSON.stringify({ testId: "validation-message" }),
        },
      });
      expect(evidence?.annotation.label).toMatch(/expected text/i);
      expect(evidence?.annotation.testResultRelated).toBe(true);
    }
  }, 60_000);

  it("records screenshot and trace Evidence Gaps instead of unsafe bytes for a protected secret-resolved attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-skills-demo-protected-"));
    roots.push(root);

    const secret = "never-persist-demo-secret";
    const result = await runDemo({ root, protectedEnvironment: true, resolvedSecret: secret });

    expect(result.files.some((file) => file.startsWith("screenshots/"))).toBe(false);
    expect(result.files.some((file) => file.startsWith("traces/"))).toBe(false);
    expect(result.screenshotEvidenceGaps).toHaveLength(2);
    expect(result.traceEvidenceGaps).toHaveLength(2);
    expect([...result.screenshotEvidenceGaps, ...result.traceEvidenceGaps].every((gap) => /protected|secret/i.test(gap.reason))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    for (const path of await filesUnder(root)) expect(await readFile(path)).not.toContain(Buffer.from(secret));
  }, 60_000);

  it("never persists screenshot pixels or trace bytes after resolving a visible secret in a non-protected session", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-skills-demo-secret-"));
    roots.push(root);

    const secret = "visible-secret-that-must-never-persist";
    const result = await runDemo({ root, resolvedSecret: secret });

    expect(result.files.some((file) => file.startsWith("screenshots/"))).toBe(false);
    expect(result.files.some((file) => file.startsWith("traces/"))).toBe(false);
    expect(result.screenshotEvidenceGaps).toHaveLength(2);
    expect(result.traceEvidenceGaps).toHaveLength(2);
    expect([...result.screenshotEvidenceGaps, ...result.traceEvidenceGaps].every((gap) => /secret/i.test(gap.reason))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    for (const path of await filesUnder(root)) expect(await readFile(path)).not.toContain(Buffer.from(secret));
  }, 60_000);
});

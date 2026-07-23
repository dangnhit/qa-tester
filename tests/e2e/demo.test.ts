import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDemo } from "../../scripts/run-demo.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
  }, 60_000);
});

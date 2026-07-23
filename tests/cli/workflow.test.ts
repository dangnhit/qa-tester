import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/program.js";
import { scaffoldWorkflowInput } from "../../src/cli/workflow.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const environment = { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "env", name: "Fixture", classification: "test", baseUrl: "https://fixture.test", productionReadOnly: false } as const;

describe("workflow scaffold", () => {
  it("creates parseable plan and source-bound inputs without scanning for a latest run", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-workflow-scaffold-")); roots.push(root);
    const envPath = join(root, "environment.json"); const planPath = join(root, "plan.json");
    await writeFile(envPath, JSON.stringify(environment));
    const plan = await scaffoldWorkflowInput({ root, mode: "plan", outputPath: planPath, environmentPath: envPath });
    expect(plan).toMatchObject({ root, mode: "plan", environmentProfile: environment });
    const workspace = await RunWorkspace.create({ root, mode: "plan", environmentProfile: environment });
    await workspace.close();
    const metadataPath = join(root, "qa-results", workspace.runId, "run-metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    await writeFile(metadataPath, JSON.stringify({ ...metadata, status: "COMPLETED" }));
    const sourcePath = join(root, "source.json");
    const source = await scaffoldWorkflowInput({ root, mode: "full", outputPath: sourcePath, sourceRoot: root, sourceRunId: workspace.runId });
    expect(source).toMatchObject({ mode: "full", bundle: { sourceRunId: workspace.runId }, environmentProfile: environment });
    expect(JSON.parse(await readFile(sourcePath, "utf8"))).toEqual(source);
    const verified = await runCli(["runtime", "verify", "--range", ">=0.1.0 <1.0.0"], { cwd: root });
    expect(verified.exitCode).toBe(0); expect(JSON.parse(verified.stdout)).toMatchObject({ compatible: true });
  });
});

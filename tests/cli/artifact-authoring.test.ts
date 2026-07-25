import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { agentDraftSkeletons, agentDraftTypes } from "../../src/cli/artifact-drafts.js";
import { ExitCode } from "../../src/cli/exit-codes.js";
import { runCli } from "../../src/cli/program.js";
import { schemas } from "../../src/contracts/catalog.js";
import { validateArtifact } from "../../src/contracts/validator.js";
import { sha256Fingerprint } from "../../src/planning/testcase-revision.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "qa-skills-cli-authoring-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Extracts every `<!-- artifact-authoring:example TYPE -->` fenced JSON block from the reference doc. */
async function readDocExamples(): Promise<Map<string, unknown>> {
  const text = await readFile(new URL("../../skills/shared/references/artifact-authoring.md", import.meta.url), "utf8");
  const pattern = /<!-- artifact-authoring:example (?<type>[a-z-]+) -->\r?\n```json\r?\n(?<json>[\s\S]*?)\r?\n```/g;
  const examples = new Map<string, unknown>();
  for (const match of text.matchAll(pattern)) {
    const type = match.groups?.type;
    const json = match.groups?.json;
    if (!type || !json) throw new Error("Malformed artifact-authoring example marker");
    examples.set(type, JSON.parse(json));
  }
  return examples;
}

describe("artifact-authoring.md examples", () => {
  it("has exactly one example per agent-drafted type, and every example validates against its schema", async () => {
    const examples = await readDocExamples();
    expect([...examples.keys()].sort()).toEqual([...agentDraftTypes].sort());
    for (const type of agentDraftTypes) {
      const example = examples.get(type);
      const result = validateArtifact(type, example);
      expect(result.valid, `${type} example: ${JSON.stringify(result.errors)}`).toBe(true);
    }
  });

  it("keeps the test-plan example free of the runtime-derived approvalDecision field", async () => {
    const examples = await readDocExamples();
    const plan = examples.get("test-plan") as Record<string, unknown>;
    expect(plan).not.toHaveProperty("approvalDecision");
  });

  it("matches the draft init skeletons exactly (single source, no divergent copy)", async () => {
    const examples = await readDocExamples();
    for (const type of agentDraftTypes) {
      expect(examples.get(type)).toEqual(agentDraftSkeletons[type]);
    }
  });
});

describe("qa-skill schema show", () => {
  it("prints the exact compiled schema for a known type", async () => {
    const directory = await root();
    const result = await runCli(["schema", "show", "--type", "test-plan"], { cwd: directory });
    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(schemas["test-plan"]);
  });

  it("prints distinct schemas for each of the 4 agent-drafted types", async () => {
    const directory = await root();
    for (const type of agentDraftTypes) {
      const result = await runCli(["schema", "show", "--type", type], { cwd: directory });
      expect(result.exitCode).toBe(ExitCode.SUCCESS);
      expect(JSON.parse(result.stdout)).toEqual(schemas[type]);
    }
  });

  it("rejects an unknown artifact type as invalid input", async () => {
    const directory = await root();
    const result = await runCli(["schema", "show", "--type", "not-a-real-type"], { cwd: directory });
    expect(result.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(result.stderr).toMatch(/unsupported artifact type/i);
    expect(result.stdout).toBe("");
  });
});

describe("qa-skill draft init", () => {
  it("prints a skeleton that validates for each of the 4 agent-drafted types", async () => {
    const directory = await root();
    for (const type of agentDraftTypes) {
      const result = await runCli(["draft", "init", "--type", type], { cwd: directory });
      expect(result.exitCode).toBe(ExitCode.SUCCESS);
      const draft: unknown = JSON.parse(result.stdout);
      const validation = validateArtifact(type, draft);
      expect(validation.valid, `${type} draft: ${JSON.stringify(validation.errors)}`).toBe(true);
      expect(draft).toEqual(agentDraftSkeletons[type]);
    }
  });

  it("omits the runtime-derived approvalDecision from the test-plan draft", async () => {
    const directory = await root();
    const result = await runCli(["draft", "init", "--type", "test-plan"], { cwd: directory });
    const draft = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(draft).not.toHaveProperty("approvalDecision");
  });

  it("notes on stderr that test-case has no standalone ingest and must be fingerprinted", async () => {
    const directory = await root();
    const result = await runCli(["draft", "init", "--type", "test-case"], { cwd: directory });
    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stderr).toMatch(/no standalone/i);
    expect(result.stderr).toMatch(/workflow bootstrap/i);
    expect(result.stderr).toMatch(/fingerprint/i);
    // stdout must stay pure JSON — the note belongs on stderr only.
    expect(() => { JSON.parse(result.stdout) as unknown; }).not.toThrow();
  });

  it("rejects a runtime-owned type with a clear error instead of a skeleton", async () => {
    const directory = await root();
    const result = await runCli(["draft", "init", "--type", "run-metadata"], { cwd: directory });
    expect(result.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(result.stderr).toMatch(/runtime-owned/i);
    expect(result.stdout).toBe("");
  });

  it("rejects a wholly unknown artifact type as invalid input", async () => {
    const directory = await root();
    const result = await runCli(["draft", "init", "--type", "not-a-real-type"], { cwd: directory });
    expect(result.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(result.stdout).toBe("");
  });
});

describe("qa-skill fingerprint", () => {
  it("matches sha256Fingerprint for a known JSON file", async () => {
    const directory = await root();
    const filePath = join(directory, "candidate.json");
    const candidate = { testCaseId: "TC-1", title: "Save", steps: [{ id: "s1", action: "navigate", sideEffect: "none" }] };
    await writeFile(filePath, JSON.stringify(candidate));

    const result = await runCli(["fingerprint", "--file", filePath], { cwd: directory });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(sha256Fingerprint(candidate));
    expect(result.stdout.trim()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is order-independent, matching the exact revisionId a real test-case draft would use", async () => {
    const directory = await root();
    const filePath = join(directory, "candidate.json");
    // Deliberately different key order than the object literal below.
    await writeFile(filePath, '{"steps":[{"id":"s1","action":"navigate","sideEffect":"none"}],"testCaseId":"TC-1"}');

    const result = await runCli(["fingerprint", "--file", filePath], { cwd: directory });

    expect(result.stdout.trim()).toBe(sha256Fingerprint({ testCaseId: "TC-1", steps: [{ id: "s1", action: "navigate", sideEffect: "none" }] }));
  });

  it("fails clearly on a missing file", async () => {
    const directory = await root();
    const result = await runCli(["fingerprint", "--file", join(directory, "missing.json")], { cwd: directory });
    expect(result.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stdout).toBe("");
  });

  it("fails clearly on invalid JSON", async () => {
    const directory = await root();
    const filePath = join(directory, "broken.json");
    await writeFile(filePath, "{ not json");
    const result = await runCli(["fingerprint", "--file", filePath], { cwd: directory });
    expect(result.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stdout).toBe("");
  });
});

describe("qa-skill --help documents the authoring helpers", () => {
  it("lists schema, draft, and fingerprint with descriptions", async () => {
    const directory = await root();
    const result = await runCli(["--help"], { cwd: directory });
    expect(result.stdout).toMatch(/schema\s+Inspect artifact JSON Schemas/);
    expect(result.stdout).toMatch(/draft\s+Author agent-drafted artifacts/);
    expect(result.stdout).toMatch(/fingerprint.*Compute the sha256 content fingerprint/);
  });
});

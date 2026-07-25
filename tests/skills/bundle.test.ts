import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "skills");
const names = ["qa-tester", "requirement-analyzer", "testcase-designer", "test-data-manager", "browser-test-executor", "evidence-collector", "bug-reporter", "qa-report-generator"];
// These four previously mislabelled a full `workflow scaffold` -> `workflow run` pipeline example
// as "standalone" (it depends on a prior run and drives the whole orchestrated workflow). Only
// requirement-analyzer's `run create` + `artifact ingest` example is genuinely standalone.
const previouslyMislabelledStandalone = ["browser-test-executor", "bug-reporter", "qa-report-generator", "evidence-collector"];

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return collectMarkdownFiles(full);
    return entry.name.endsWith(".md") ? [full] : [];
  }));
  return nested.flat();
}

describe("portable QA skill bundle", () => {
  it("has canonical standard skills with local runtime guidance", async () => {
    for (const name of names) {
      const text = await readFile(resolve(root, name, "SKILL.md"), "utf8");
      expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---`, "s"));
      expect(text).toContain("Execution kind:");
      expect(text).toContain("node_modules/.bin/qa-skill");
      expect(text).not.toMatch(/npx\\s+--yes/i);
      expect(text).toContain("Example");
      expect(text).toMatch(/full/i);
      if (!["requirement-analyzer", "testcase-designer"].includes(name)) expect(text).toContain("workflow run --input");
      // "standalone" is only claimed where an example genuinely does not depend on a prior run
      // or drive the full `workflow scaffold` -> `workflow run` pipeline.
      if (previouslyMislabelledStandalone.includes(name)) expect(text).not.toMatch(/standalone/i);
    }
    const requirementAnalyzer = await readFile(resolve(root, "requirement-analyzer", "SKILL.md"), "utf8");
    expect(requirementAnalyzer).toMatch(/standalone/i);
    expect(requirementAnalyzer).toContain("run create --root . --mode plan --environment-file environment.json");
    expect(requirementAnalyzer).toContain("--run-id $Run.runId");
    expect(requirementAnalyzer).not.toContain("--run-id RUN_ID");
    const qaTester = await readFile(resolve(root, "qa-tester", "SKILL.md"), "utf8");
    const powerShell = qaTester.slice(qaTester.indexOf("PowerShell:"));
    expect(powerShell).toContain("& $QaSkill workflow bootstrap --root . --environment-file environment.json --requirement-file drafts/requirements.json --plan-file drafts/plan.json --test-case-file drafts/case.json --coverage-file drafts/coverage.json");
  });

  it("never carries the literal unresolved SOURCE_RUN_ID placeholder as a bare command argument", async () => {
    const files = await collectMarkdownFiles(root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      // Every `--source-run-id` value must be a captured variable reference (e.g. "$SOURCE_RUN_ID"
      // or $Bootstrap.runId), never the bare literal token an agent cannot resolve by copy-pasting.
      expect(text, file).not.toMatch(/--source-run-id\s+SOURCE_RUN_ID(\s|`|$)/);
    }
  });
});

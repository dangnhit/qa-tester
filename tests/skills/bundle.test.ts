import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { observedEntrySurfaces } from "../../src/observed/report-mapping.js";
import { removedRunnerReportFields } from "../../src/observed/sanitize-report.js";

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

  /**
   * Lane 2's adapter document is the only place a spec author learns the tag format, and a producer no
   * document mentions is unreachable in practice. These assertions pin the prose to the code it
   * describes: the surfaces a batch entry may name, and the fields the registered evidence drops.
   */
  it("documents lane 2 against the exported constants rather than from memory", async () => {
    const reference = await readFile(resolve(root, "shared", "references", "observed-execution.md"), "utf8");
    const readme = await readFile(resolve(process.cwd(), "README.md"), "utf8");
    // Every agent-facing document that enumerates Execution Surfaces. Landing lane 2 made two of them
    // false at once — they still called all five "surfaces no executor covers" — so the surface list
    // is pinned wherever it is written, not only where lane 2 is introduced. A sixth surface, or a
    // surface leaving `observedEntrySurfaces`, now reddens every document that names the set.
    const surfaceDocuments = {
      "observed-execution.md": reference,
      "README.md": readme,
      "browser-test-executor/SKILL.md": await readFile(resolve(root, "browser-test-executor", "SKILL.md"), "utf8"),
      "recovery.md": await readFile(resolve(root, "shared", "references", "recovery.md"), "utf8"),
      "artifact-authoring.md": await readFile(resolve(root, "shared", "references", "artifact-authoring.md"), "utf8"),
    };
    for (const [name, document] of Object.entries(surfaceDocuments)) {
      for (const surface of observedEntrySurfaces) expect(document, `${name} omits ${surface}`).toContain(`\`${surface}\``);
    }

    for (const document of [reference, readme]) {
      expect(document).toContain("qa-skill execute playwright");
      expect(document).toContain("[qa:<testCaseId>/<revisionId>/<instanceId>@<surface>]");
      for (const surface of observedEntrySurfaces) expect(document).toContain(`\`${surface}\``);
      // Lane 2 producing no browser entry is a human ruling; a document that forgot to say so would
      // leave a spec author tagging `browser` and discovering the refusal at run time.
      expect(document).toMatch(/`browser` is refused|A spec tagged `browser`/);
    }
    // The reference is the document that CLAIMS to list every removal, so a field added to the code
    // and forgotten here reddens. Matched as a backticked token ending in the field's leaf name, so
    // `config.argv` satisfies `argv` while `errors` does not satisfy `error`.
    for (const field of removedRunnerReportFields) {
      expect(reference, field).toMatch(new RegExp(`\`[^\`]*\\b${field.split(".").at(-1) ?? field}\``));
    }
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

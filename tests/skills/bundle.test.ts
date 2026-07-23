import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "skills");
const names = ["qa-tester", "requirement-analyzer", "testcase-designer", "test-data-manager", "browser-test-executor", "evidence-collector", "bug-reporter", "qa-report-generator"];

describe("portable QA skill bundle", () => {
  it("has canonical standard skills with local runtime guidance", async () => {
    for (const name of names) {
      const text = await readFile(resolve(root, name, "SKILL.md"), "utf8");
      expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---`, "s"));
      expect(text).toContain("Execution kind:");
      expect(text).toContain("node_modules/.bin/qa-skill");
      expect(text).not.toMatch(/npx\\s+--yes/i);
      expect(text).toContain("Example");
      expect(text).toMatch(/standalone/i);
      expect(text).toMatch(/full/i);
      if (!["requirement-analyzer", "testcase-designer"].includes(name)) expect(text).toContain("workflow run --input");
    }
    expect(await readdir(resolve(root, "qa-tester"))).not.toContain("agents");
  });
});

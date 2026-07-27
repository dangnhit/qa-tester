import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("installed Unix CLI", () => {
  it.runIf(process.platform !== "win32")("packs with an executable shebang and its Playwright runtime dependency", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-skills-installed-cli-"));
    try {
      await run("npm", ["run", "build"], { cwd: process.cwd() });
      const packed = await run("npm", ["pack", "--json", "--pack-destination", root], { cwd: process.cwd() });
      const filename = (JSON.parse(packed.stdout) as { filename: string }[])[0]?.filename;
      if (!filename) throw new Error("npm pack did not return a filename");
      await run("npm", ["install", "--ignore-scripts", "--no-package-lock", join(root, filename)], { cwd: root });

      const executable = join(root, "node_modules", ".bin", "qa-skill");
      const directCli = join(root, "node_modules", "@vigentix", "qa-skills", "dist", "src", "cli", "index.js");
      expect(await readFile(join(root, "node_modules", "@vigentix", "qa-skills", "dist", "src", "cli", "index.js"), "utf8")).toMatch(/^#!\/usr\/bin\/env node/);
      const verified = await run(executable, ["runtime", "verify", "--range", ">=0.1.0 <1.0.0"], { cwd: root });
      expect(JSON.parse(verified.stdout)).toMatchObject({ version: "0.3.0", compatible: true });
      await run(executable, ["skills", "install", "--agent", "codex"], { cwd: root });
      await rm(executable);
      try {
        await run(process.execPath, [directCli, "skills", "verify", "--agent", "codex"], { cwd: root });
        throw new Error("Expected verification to fail after removing the recorded runtime");
      } catch (error: unknown) {
        const failure = error as { code?: number; stdout?: string };
        expect(failure.code).toBe(1);
        expect(JSON.parse(failure.stdout ?? "{}")).toMatchObject({ status: "runtime-missing", runtime: { status: "runtime-missing" } });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

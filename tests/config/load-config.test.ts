import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadQaConfig } from "../../src/config/load-config.js";
import { resolveSecretReferences, scrubResolvedSecrets } from "../../src/config/secret-resolver.js";

async function config(root: string, relative: string, contents: string): Promise<string> {
  const file = join(root, relative);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, contents);
  return file;
}

describe("loadQaConfig", () => {
  it("uses exactly the explicit config and resolves relative paths from its directory", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp("/tmp/qa-config-"));
    const explicit = await config(root, "configs/qa.config.yaml", "version: 1\nartifactDirectory: ./artifacts\n");
    await config(root, "qa.config.yaml", "version: 1\nartifactDirectory: ./wrong\n");

    const loaded = await loadQaConfig({ cwd: root, configPath: explicit });

    expect(loaded.configPath).toBe(await import("node:fs/promises").then(({ realpath }) => realpath(explicit)));
    expect(loaded.artifactDirectory).toBe(join(await import("node:fs/promises").then(({ realpath }) => realpath(root)), "configs", "artifacts"));
  });

  it("chooses the nearest supported config without merging and rejects executable TypeScript", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp("/tmp/qa-config-"));
    await config(root, "qa.config.yaml", "version: 1\nmetadata:\n  owner: root\n");
    const nested = await config(root, "packages/shop/qa.config.yaml", "version: 1\nmetadata:\n  owner: shop\n");
    await mkdir(join(root, "packages/shop/src"), { recursive: true });
    await config(root, "packages/shop/qa.config.ts", "export default {};\n");

    const loaded = await loadQaConfig({ cwd: join(root, "packages/shop/src") });
    expect(loaded.configPath).toBe(await import("node:fs/promises").then(({ realpath }) => realpath(nested)));
    expect(loaded.snapshot).toMatchObject({ metadata: { owner: "shop" } });
    await expect(loadQaConfig({ cwd: root, configPath: join(root, "packages/shop/qa.config.ts") })).rejects.toThrow(/executable|typescript|json|yaml/i);
  });

  it("keeps secret references in the snapshot and resolves/scrubs only operation memory", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp("/tmp/qa-config-"));
    await config(root, "qa.config.yaml", "version: 1\nheaders:\n  authorization: ${ENV:QA_TOKEN}\n");
    const loaded = await loadQaConfig({ cwd: root });
    const resolved = resolveSecretReferences(loaded.snapshot, { QA_TOKEN: "very-secret-value" });

    expect(JSON.stringify(loaded.snapshot)).toContain("${ENV:QA_TOKEN}");
    expect(JSON.stringify(resolved.value)).toContain("very-secret-value");
    expect(JSON.stringify(scrubResolvedSecrets({ error: "very-secret-value failed" }, resolved.values))).not.toContain("very-secret-value");
  });
});

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
  it("uses exactly the explicit config and reports its own directory, ignoring a nearer candidate", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp("/tmp/qa-config-"));
    const explicit = await config(root, "configs/qa.config.yaml", "version: 1\nheaders:\n  X-Explicit: yes-explicit\n");
    await config(root, "qa.config.yaml", "version: 1\nheaders:\n  X-Wrong: yes-wrong\n");

    const loaded = await loadQaConfig({ cwd: root, configPath: explicit });

    expect(loaded.configPath).toBe(await import("node:fs/promises").then(({ realpath }) => realpath(explicit)));
    expect(loaded.configDirectory).toBe(join(await import("node:fs/promises").then(({ realpath }) => realpath(root)), "configs"));
    expect(loaded.snapshot).toMatchObject({ headers: { "X-Explicit": "yes-explicit" } });
  });

  it("chooses the nearest supported config without merging and rejects executable TypeScript", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp("/tmp/qa-config-"));
    await config(root, "qa.config.yaml", "version: 1\nheaders:\n  X-Scope: root\n");
    const nested = await config(root, "packages/shop/qa.config.yaml", "version: 1\nheaders:\n  X-Scope: shop\n");
    await mkdir(join(root, "packages/shop/src"), { recursive: true });
    await config(root, "packages/shop/qa.config.ts", "export default {};\n");

    const loaded = await loadQaConfig({ cwd: join(root, "packages/shop/src") });
    expect(loaded.configPath).toBe(await import("node:fs/promises").then(({ realpath }) => realpath(nested)));
    expect(loaded.snapshot).toMatchObject({ headers: { "X-Scope": "shop" } });
    await expect(loadQaConfig({ cwd: root, configPath: join(root, "packages/shop/qa.config.ts") })).rejects.toThrow(/executable|typescript|json|yaml/i);
  });

  it("rejects unknown config fields and malformed trusted hook descriptors", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp("/tmp/qa-config-"));
    const unknown = await config(root, "unknown.yaml", "version: 1\nunknown: true\n");
    const malformed = await config(root, "malformed.yaml", "version: 1\nhooks:\n  - id: seed\n    kind: command\n    command: node\n");
    await expect(loadQaConfig({ cwd: root, configPath: unknown })).rejects.toThrow(/config|schema|unknown/i);
    await expect(loadQaConfig({ cwd: root, configPath: malformed })).rejects.toThrow(/config|schema|hook/i);
  });

  it("rejects the removed artifactDirectory field as a schema error", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp("/tmp/qa-config-"));
    const removedField = await config(root, "artifact-directory.yaml", "version: 1\nartifactDirectory: ./artifacts\n");
    await expect(loadQaConfig({ cwd: root, configPath: removedField })).rejects.toThrow(/config|schema/i);
  });

  it("names the offending instance path and missing field when the schema check fails", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp("/tmp/qa-config-"));
    const malformed = await config(root, "malformed-fields.yaml", "version: 1\nhooks:\n  - id: seed\n    kind: command\n    command: node\n");

    const error: Error = await loadQaConfig({ cwd: root, configPath: malformed }).then(
      () => { throw new Error("expected loadQaConfig to reject"); },
      (caught: unknown) => caught as Error,
    );

    expect(error.message).toContain("/hooks/0");
    expect(error.message).toContain("args");
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

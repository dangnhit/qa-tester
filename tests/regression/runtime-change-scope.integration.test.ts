import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { sha256Text } from "../../src/core/checksum.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { registerChangeScope } from "../../src/regression/change-scope.js";

const environment = { artifactType: "environment-profile", schemaVersion: "1.0.0", producerVersion: "1.0.0", environmentProfileId: "ENV-REG", name: "test", classification: "test", baseUrl: "https://example.test", productionReadOnly: false };

describe("runtime-owned change scope", () => {
  it("rejects a rechecksummed mapping mutation when the workspace is reopened", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-change-scope-"));
    try {
      const workspace = await RunWorkspace.create({ root, mode: "regression", environmentProfile: environment });
      const registered = await registerChangeScope({ workspace, changes: [{ id: "login", requirementIds: ["REQ-LOGIN"], codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }], provenance: { kind: "git-diff", reference: "abc..def" } });
      const artifactPath = await workspace.resolve(registered.relativePath);
      const value = JSON.parse(await readFile(artifactPath, "utf8")) as { changes: { id: string }[] };
      value.changes[0]!.id = "tampered";
      const contents = `${JSON.stringify(value, null, 2)}\n`;
      await writeFile(artifactPath, contents);
      const manifestPath = join(workspace.path, "artifact-manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifacts: { id: string; sha256: string }[] };
      manifest.artifacts.find((artifact) => artifact.id === registered.id)!.sha256 = sha256Text(contents);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await expect(workspace.readRegisteredArtifacts()).rejects.toThrow(/checksum.*mapping|mapping.*checksum/i);
      await workspace.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  /**
   * The producer's own half of `isChangeScope`. The CLI edge applies the same guard first, so this refusal
   * is unreachable through `workflow scaffold` — which is exactly why it must be tested directly rather
   * than left as an untested claim: the seam it protects is a PROGRAMMATIC caller passing a change through
   * `changeScopeSources`, where nothing but TypeScript stands between a hand-built object and the
   * canonicalizing sort that used to throw a raw `TypeError` with no error code.
   */
  it("refuses a change missing a mapping array, rather than throwing a raw TypeError from its own sort", async () => {
    const workspace = { runId: "RUN-SHAPE", registerArtifactValue: () => { throw new Error("must not register a malformed change scope"); } };

    const failure = await registerChangeScope({
      workspace,
      changes: [{ id: "login", codeSurfaces: [], declaredDependencies: [], gitPaths: [], userScope: [] }] as never,
      provenance: { kind: "git-diff", reference: "abc..def" },
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(TypeError);
    expect((failure as Error).message).toMatch(/requirementIds/);
  });
});

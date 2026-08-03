import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { sha256Text } from "../../src/core/checksum.js";
import { QaSkillsError } from "../../src/core/errors.js";
import { RunWorkspace } from "../../src/core/run-workspace.js";
import { registerChangeScope, regressionCaseFromCanonical } from "../../src/regression/change-scope.js";

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

    // Item 2.1 (phase9-debt-clearing task 3): the file's own docblock above `isChangeScope` already
    // narrates the exit-5 consequence of an UNCODED throw here -- so the failure must be a `QaSkillsError`
    // with a code `program.ts` maps to exit 3, not merely "some Error that is not a TypeError". A bare
    // `Error` would satisfy the two assertions below just as well, which is exactly what this file's own
    // three throws did before this fix.
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(TypeError);
    expect(failure).toBeInstanceOf(QaSkillsError);
    expect((failure as QaSkillsError).code).toBe("INVALID_ARTIFACT");
    expect((failure as Error).message).toMatch(/requirementIds/);
  });

  // Item 2.1's other two throws: an empty change list, and a canonical test case whose regression identity
  // is itself malformed. Both were bare `Error`s with no code, landing on exit 5 exactly like the sort's
  // raw TypeError the test above guards -- fixed the same way, and tested directly here because neither is
  // reachable through `workflow scaffold`'s own pre-checks (src/cli/workflow.ts), only through a
  // programmatic caller or a hand-edited canonical test case.
  it("refuses an empty change list as a coded refusal, not a bare Error", async () => {
    const workspace = { runId: "RUN-EMPTY", registerArtifactValue: () => { throw new Error("must not register an empty change scope"); } };

    const failure = await registerChangeScope({
      workspace,
      changes: [],
      provenance: { kind: "git-diff", reference: "abc..def" },
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(QaSkillsError);
    expect((failure as QaSkillsError).code).toBe("INVALID_ARTIFACT");
    expect((failure as Error).message).toMatch(/at least one declared change/i);
  });

  it("refuses a canonical test case lacking its exact regression identity as a coded refusal, not a bare Error", () => {
    let failure: unknown;
    try {
      regressionCaseFromCanonical({ revisionId: "REV-1", instanceId: "INSTANCE-1" });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(QaSkillsError);
    expect((failure as QaSkillsError).code).toBe("INVALID_ARTIFACT");
    expect((failure as Error).message).toMatch(/regression instance identity/i);
  });
});

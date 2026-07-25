import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";

import { executeAction } from "../../src/browser/playwright/executor.js";
import { QaSkillsError } from "../../src/core/errors.js";
import type { BrowserAction } from "../../src/browser/types.js";
import type { LaneSafetyContext } from "../../src/safety/navigation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** Creates a runtime-owned workspace with an empty, existing `uploads/` root and returns that root. */
async function makeUploadRoot(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "qa-skills-upload-"));
  roots.push(workspace);
  const uploadRoot = join(workspace, "uploads");
  await mkdir(uploadRoot, { recursive: true });
  return uploadRoot;
}

/** A fake Page whose only capability is to record every `setInputFiles` argument list. */
function fakePage(): { page: Page; uploaded: string[][] } {
  const uploaded: string[][] = [];
  const locator = { setInputFiles: (files: string[]) => { uploaded.push(files); return Promise.resolve(); } };
  const page = { locator: () => locator } as unknown as Page;
  return { page, uploaded };
}

const navigation = { baseUrl: "https://app.example.test", classification: "test" } as const;
function safetyWith(uploadRoot: string): LaneSafetyContext {
  return { navigation, uploadRoot };
}

function uploadAction(files: string[]): BrowserAction {
  return { kind: "upload", locator: { css: "#file" }, files };
}

/** Runs `fn`, asserts it rejected with a QaSkillsError of `code`. */
async function expectRejection(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(QaSkillsError);
    expect((error as QaSkillsError).code).toBe(code);
    return;
  }
  throw new Error(`expected the upload guard to reject with ${code} but it resolved`);
}

describe("upload guard (executeAction upload case)", () => {
  it("accepts a real file inside uploads/ and passes its realpath'd path to setInputFiles", async () => {
    const uploadRoot = await makeUploadRoot();
    await writeFile(join(uploadRoot, "fixture.txt"), "hello");
    const canonical = await realpath(join(uploadRoot, "fixture.txt"));
    const { page, uploaded } = fakePage();

    await executeAction(page, uploadAction(["fixture.txt"]), undefined, safetyWith(uploadRoot));

    // The realpath'd (canonical) path is passed, NOT the raw caller string — on
    // macOS the tmpdir symlink makes the canonical path differ from the join.
    expect(uploaded).toEqual([[canonical]]);
  });

  it("accepts a real absolute path already inside uploads/", async () => {
    const uploadRoot = await makeUploadRoot();
    const absolute = join(uploadRoot, "abs.txt");
    await writeFile(absolute, "x");
    const canonical = await realpath(absolute);
    const { page, uploaded } = fakePage();

    await executeAction(page, uploadAction([absolute]), undefined, safetyWith(uploadRoot));

    expect(uploaded).toEqual([[canonical]]);
  });

  it("guards and canonicalizes every file of a multi-file upload, preserving order", async () => {
    const uploadRoot = await makeUploadRoot();
    await Promise.all([writeFile(join(uploadRoot, "a.txt"), "a"), writeFile(join(uploadRoot, "b.txt"), "b")]);
    const [canonicalA, canonicalB] = await Promise.all([realpath(join(uploadRoot, "a.txt")), realpath(join(uploadRoot, "b.txt"))]);
    const { page, uploaded } = fakePage();

    await executeAction(page, uploadAction(["a.txt", "b.txt"]), undefined, safetyWith(uploadRoot));

    expect(uploaded).toEqual([[canonicalA, canonicalB]]);
  });

  it("rejects a `../../etc/passwd` traversal and never calls setInputFiles", async () => {
    const uploadRoot = await makeUploadRoot();
    const { page, uploaded } = fakePage();

    await expectRejection(() => executeAction(page, uploadAction(["../../etc/passwd"]), undefined, safetyWith(uploadRoot)), "PATH_ESCAPE");
    expect(uploaded).toEqual([]);
  });

  it("rejects an absolute path outside uploads/", async () => {
    const uploadRoot = await makeUploadRoot();
    const { page, uploaded } = fakePage();

    await expectRejection(() => executeAction(page, uploadAction(["/etc/passwd"]), undefined, safetyWith(uploadRoot)), "PATH_ESCAPE");
    expect(uploaded).toEqual([]);
  });

  it("rejects a symlink inside uploads/ that points outside (SYMLINK_ESCAPE)", async () => {
    const uploadRoot = await makeUploadRoot();
    // A secret file ABOVE uploads/ (in the workspace root), reachable only via the symlink.
    const secret = join(uploadRoot, "..", "secret.txt");
    await writeFile(secret, "secret");
    await symlink(secret, join(uploadRoot, "link.txt"));
    const { page, uploaded } = fakePage();

    await expectRejection(() => executeAction(page, uploadAction(["link.txt"]), undefined, safetyWith(uploadRoot)), "SYMLINK_ESCAPE");
    expect(uploaded).toEqual([]);
  });

  it("rejects a non-existent file inside uploads/ (fail closed on a missing leaf)", async () => {
    const uploadRoot = await makeUploadRoot();
    const { page, uploaded } = fakePage();

    await expect(executeAction(page, uploadAction(["missing.txt"]), undefined, safetyWith(uploadRoot))).rejects.toThrow();
    expect(uploaded).toEqual([]);
  });

  it("fails closed when no lane-1 safety context is supplied to the upload step", async () => {
    const { page, uploaded } = fakePage();

    await expectRejection(() => executeAction(page, uploadAction(["fixture.txt"]), undefined), "UNSAFE_UPLOAD");
    expect(uploaded).toEqual([]);
  });
});

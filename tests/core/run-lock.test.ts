import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireRunLock } from "../../src/core/run-lock.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("run locks", () => {
  it("refuses a live lock and recovers a stale lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-skills-lock-"));
    roots.push(root);
    const lock = await acquireRunLock(root, { pid: process.pid, now: () => new Date("2026-07-23T12:00:00Z") });
    await expect(acquireRunLock(root)).rejects.toThrow(/live lock/i);
    await lock.release();

    const stale = await acquireRunLock(root, { pid: 999_999_999, now: () => new Date("2026-07-23T12:00:00Z") });
    await stale.release();
  });
});

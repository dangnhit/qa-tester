import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("gives exactly one concurrent contender ownership of a stale lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-skills-lock-race-"));
    roots.push(root);
    await writeFile(join(root, ".run.lock"), JSON.stringify({
      pid: 999_999_999,
      createdAt: "2026-07-23T12:00:00.000Z",
    }), { flag: "wx" });

    const attempts = await Promise.allSettled([
      acquireRunLock(root),
      acquireRunLock(root),
    ]);
    const owners = attempts.filter((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireRunLock>>> => attempt.status === "fulfilled");
    const refused = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");

    expect(owners).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toMatchObject({ code: "LIVE_LOCK" });
    await owners[0]?.value.release();
  });
});

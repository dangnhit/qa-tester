import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { QaSkillsError } from "./errors.js";
import { assertPathWithin } from "./fs.js";

type LockRecord = { pid: number; createdAt: string };

export interface RunLock {
  release(): Promise<void>;
}

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

export async function acquireRunLock(root: string, options: { pid?: number; now?: () => Date } = {}): Promise<RunLock> {
  const path = join(root, ".run.lock");
  await assertPathWithin(root, path);
  const record: LockRecord = { pid: options.pid ?? process.pid, createdAt: (options.now ?? (() => new Date()))().toISOString() };
  try {
    await writeFile(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    let existing: LockRecord | undefined;
    try {
      existing = JSON.parse(await readFile(path, "utf8")) as LockRecord;
    } catch {
      // An unreadable lock is not trustworthy and is treated as stale.
    }
    if (existing && isLivePid(existing.pid)) throw new QaSkillsError("Run has a live lock", "LIVE_LOCK");
    await rm(path, { force: true });
    await writeFile(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  }
  let released = false;
  return {
    async release(): Promise<void> {
      if (!released) {
        released = true;
        await assertPathWithin(root, path);
        await rm(path, { force: true });
      }
    },
  };
}

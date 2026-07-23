import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { QaSkillsError } from "./errors.js";
import { assertPathWithin } from "./fs.js";

type LockRecord = { pid: number; createdAt: string; token?: string };

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
  const recoveryPath = join(root, ".run.lock.recovery");
  await assertPathWithin(root, path);
  await assertPathWithin(root, recoveryPath);
  const record: LockRecord = {
    pid: options.pid ?? process.pid,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    token: crypto.randomUUID(),
  };
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
    try {
      await mkdir(recoveryPath);
    } catch (recoveryError: unknown) {
      if (recoveryError instanceof Error && "code" in recoveryError && recoveryError.code === "EEXIST") {
        throw new QaSkillsError("Run lock recovery is already owned", "LIVE_LOCK");
      }
      throw recoveryError;
    }
    try {
      let current: LockRecord | undefined;
      try {
        current = JSON.parse(await readFile(path, "utf8")) as LockRecord;
      } catch (readError: unknown) {
        if (!(readError instanceof Error && "code" in readError && readError.code === "ENOENT")) throw readError;
      }
      if (current && isLivePid(current.pid)) throw new QaSkillsError("Run has a live lock", "LIVE_LOCK");
      await rm(path, { force: true });
      try {
        await writeFile(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      } catch (writeError: unknown) {
        if (writeError instanceof Error && "code" in writeError && writeError.code === "EEXIST") {
          throw new QaSkillsError("Run lock was acquired by another owner", "LIVE_LOCK");
        }
        throw writeError;
      }
    } finally {
      await rm(recoveryPath, { recursive: true, force: true });
    }
  }
  let released = false;
  return {
    async release(): Promise<void> {
      if (!released) {
        released = true;
        await assertPathWithin(root, path);
        let current: LockRecord | undefined;
        try {
          current = JSON.parse(await readFile(path, "utf8")) as LockRecord;
        } catch (error: unknown) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (current?.token === record.token) await rm(path, { force: true });
      }
    },
  };
}

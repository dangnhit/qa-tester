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

async function readRecord(path: string): Promise<LockRecord | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LockRecord;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function acquireRecoveryLease(path: string, reclaimPath: string, record: LockRecord): Promise<() => Promise<void>> {
  try {
    await writeFile(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const existing = await readRecord(path);
    if (!existing?.token || isLivePid(existing.pid)) throw new QaSkillsError("Run lock recovery is already owned", "LIVE_LOCK");
    try {
      await mkdir(reclaimPath);
    } catch (claimError: unknown) {
      if (claimError instanceof Error && "code" in claimError && claimError.code === "EEXIST") {
        throw new QaSkillsError("Run lock recovery takeover is already owned", "LIVE_LOCK");
      }
      throw claimError;
    }
    try {
      const current = await readRecord(path);
      if (!current || current.token !== existing.token || isLivePid(current.pid)) {
        throw new QaSkillsError("Run lock recovery ownership changed", "LIVE_LOCK");
      }
      await rm(path);
      try {
        await writeFile(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      } catch (writeError: unknown) {
        if (writeError instanceof Error && "code" in writeError && writeError.code === "EEXIST") {
          throw new QaSkillsError("Run lock recovery was acquired by another owner", "LIVE_LOCK");
        }
        throw writeError;
      }
    } finally {
      await rm(reclaimPath, { recursive: true, force: true });
    }
  }

  return async () => {
    const current = await readRecord(path);
    if (current?.token === record.token) await rm(path, { force: true });
  };
}

export async function acquireRunLock(root: string, options: { pid?: number; now?: () => Date } = {}): Promise<RunLock> {
  const path = join(root, ".run.lock");
  const recoveryPath = join(root, ".run.lock.recovery");
  const recoveryReclaimPath = join(root, ".run.lock.recovery.reclaim");
  await assertPathWithin(root, path);
  await assertPathWithin(root, recoveryPath);
  await assertPathWithin(root, recoveryReclaimPath);
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
    const releaseRecovery = await acquireRecoveryLease(recoveryPath, recoveryReclaimPath, record);
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
      await releaseRecovery();
    }
  }
  let released = false;
  return {
    async release(): Promise<void> {
      if (!released) {
        await assertPathWithin(root, path);
        const current = await readRecord(path);
        if (current && current.token !== record.token) throw new QaSkillsError("Run lock ownership changed", "LOCK_OWNERSHIP");
        if (current) await rm(path);
        released = true;
      }
    },
  };
}

import { link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { QaSkillsError } from "./errors.js";
import { assertPathWithin } from "./fs.js";

type LockRecord = { pid: number; createdAt: string; token?: string };

export interface RunLock {
  release(): Promise<void>;
}

const localRecoveryTails = new Map<string, Promise<void>>();

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function isLockRecord(value: unknown): value is LockRecord {
  return typeof value === "object"
    && value !== null
    && "pid" in value
    && typeof value.pid === "number"
    && Number.isInteger(value.pid)
    && "createdAt" in value
    && typeof value.createdAt === "string";
}

async function readRecord(path: string): Promise<LockRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isLockRecord(value)) throw new SyntaxError("Malformed run lock");
    return value;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function liveLock(): QaSkillsError {
  return new QaSkillsError("Run has a live lock", "LIVE_LOCK");
}

async function withLocalRecovery<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = localRecoveryTails.get(root) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  localRecoveryTails.set(root, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (localRecoveryTails.get(root) === tail) localRecoveryTails.delete(root);
  }
}

async function collectConcurrentClaims(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 10);
  });
}

async function acquireRecoveryClaim(root: string, token: string): Promise<() => Promise<void>> {
  const claimsPath = join(root, ".run.lock.claims");
  const claimPath = join(claimsPath, `${token}.json`);
  await assertPathWithin(root, claimsPath);
  await assertPathWithin(root, claimPath);
  await mkdir(claimsPath, { recursive: true, mode: 0o700 });
  await writeFile(claimPath, JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token,
  }), { flag: "wx", mode: 0o600 });

  const release = async (): Promise<void> => {
    await rm(claimPath, { force: true });
  };
  try {
    // Give claims that observed the same stale lock a chance to enter the
    // deterministic election before any contender moves the shared lock.
    await collectConcurrentClaims();
    const activeTokens: string[] = [];
    for (const entry of await readdir(claimsPath)) {
      const candidatePath = join(claimsPath, entry);
      await assertPathWithin(root, candidatePath);
      let candidate: LockRecord | undefined;
      try {
        candidate = await readRecord(candidatePath);
      } catch {
        await rm(candidatePath, { force: true });
        continue;
      }
      if (!candidate?.token || !isLivePid(candidate.pid)) {
        await rm(candidatePath, { force: true });
        continue;
      }
      activeTokens.push(candidate.token);
    }
    activeTokens.sort();
    if (activeTokens[0] !== token) throw liveLock();
    return release;
  } catch (error: unknown) {
    await release();
    throw error;
  }
}

export async function acquireRunLock(
  root: string,
  options: { pid?: number; now?: () => Date } = {},
): Promise<RunLock> {
  const path = join(root, ".run.lock");
  await assertPathWithin(root, path);
  const record: LockRecord = {
    pid: options.pid ?? process.pid,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    token: crypto.randomUUID(),
  };
  const contents = JSON.stringify(record);

  for (;;) {
    try {
      await writeFile(path, contents, { flag: "wx", mode: 0o600 });
      break;
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }

    let existing: LockRecord | undefined;
    try {
      existing = await readRecord(path);
    } catch {
      // Malformed lock data cannot establish live ownership and is reclaimed.
    }
    if (existing && isLivePid(existing.pid)) throw liveLock();

    await withLocalRecovery(root, async () => {
      let current: LockRecord | undefined;
      try {
        current = await readRecord(path);
      } catch {
        // Malformed lock data remains eligible for quarantine.
      }
      if (current && isLivePid(current.pid)) throw liveLock();

      const releaseClaim = await acquireRecoveryClaim(root, record.token as string);
      try {
        try {
          current = await readRecord(path);
        } catch {
          current = undefined;
        }
        if (current && isLivePid(current.pid)) throw liveLock();
        const quarantinePath = join(root, `.run.lock.stale-${crypto.randomUUID()}`);
        await assertPathWithin(root, quarantinePath);
        let quarantined = false;
        try {
          await rename(path, quarantinePath);
          quarantined = true;
        } catch (error: unknown) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }

        try {
          if (quarantined) {
            let quarantinedRecord: LockRecord | undefined;
            try {
              quarantinedRecord = await readRecord(quarantinePath);
            } catch {
              // Malformed quarantined data is stale.
            }
            if (quarantinedRecord && isLivePid(quarantinedRecord.pid)) {
              try {
                await link(quarantinePath, path);
              } catch (error: unknown) {
                if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
              }
              throw liveLock();
            }
          }
          try {
            await writeFile(path, contents, { flag: "wx", mode: 0o600 });
          } catch (error: unknown) {
            if (error instanceof Error && "code" in error && error.code === "EEXIST") throw liveLock();
            throw error;
          }
        } finally {
          if (quarantined) await rm(quarantinePath, { force: true });
        }
      } finally {
        await releaseClaim();
      }
    });
    break;
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      await assertPathWithin(root, path);
      const current = await readRecord(path);
      if (current && current.token !== record.token) {
        throw new QaSkillsError("Run lock ownership changed", "LOCK_OWNERSHIP");
      }
      if (current) await rm(path);
      released = true;
    },
  };
}

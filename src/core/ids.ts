import { randomBytes } from "node:crypto";

import { ulid } from "ulid";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function createRunId(now: Date = new Date()): string {
  const timestamp = [
    String(now.getUTCFullYear()).padStart(4, "0"),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
  ].join("");
  const time = [pad(now.getUTCHours()), pad(now.getUTCMinutes()), pad(now.getUTCSeconds())].join("");
  const suffix = randomBytes(3).toString("hex");

  return `${timestamp}T${time}Z-${suffix}`;
}

export function createEntityId(now?: number): string {
  return now === undefined ? ulid() : ulid(now);
}

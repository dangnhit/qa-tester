export type ResolvedSecrets<T> = { value: T; values: readonly string[] };

function resolve(value: unknown, environment: Readonly<Record<string, string | undefined>>, values: string[]): unknown {
  if (typeof value === "string") {
    const match = /^\$\{ENV:([A-Z_][A-Z0-9_]*)\}$/.exec(value);
    if (!match) return value;
    const resolved = environment[match[1] ?? ""];
    if (!resolved) throw new Error(`Secret reference ${value} is unresolved`);
    values.push(resolved);
    return resolved;
  }
  if (Array.isArray(value)) return value.map((item) => resolve(item, environment, values));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, environment, values)]));
  return value;
}

/** Resolves references into a short-lived operation value; callers must never register this value. */
export function resolveSecretReferences<T>(snapshot: T, environment: Readonly<Record<string, string | undefined>> = process.env): ResolvedSecrets<T> {
  const values: string[] = [];
  return { value: resolve(snapshot, environment, values) as T, values: [...new Set(values)] };
}

function scrub(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return secrets.reduce((result, secret) => result.split(secret).join("[REDACTED]"), value);
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, secrets)]));
  return value;
}

export function scrubResolvedSecrets<T>(value: T, secrets: readonly string[]): T {
  return scrub(value, secrets) as T;
}

/** Runs one operation with ephemeral resolved values and guarantees returned data and thrown diagnostics are scrubbed. */
export type ResolvedSecretOperation = Readonly<{ value: unknown; scrub: <T>(value: T) => T }>;

export async function withResolvedSecrets<T>(
  snapshot: unknown,
  environment: Readonly<Record<string, string | undefined>>,
  operation: (context: ResolvedSecretOperation) => Promise<T>,
): Promise<T> {
  const resolved = resolveSecretReferences(snapshot, environment);
  try {
    const scrub = <U>(value: U): U => scrubResolvedSecrets(value, resolved.values);
    return scrub(await operation({ value: resolved.value, scrub }));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(scrubResolvedSecrets(message, resolved.values));
  }
}

import { lookup } from "node:dns/promises";

import { QaSkillsError } from "../core/errors.js";
import { isRecord } from "../core/values.js";

/**
 * Lane-1 SSRF guard for the browser DSL `open` step.
 *
 * `assertNavigable` refuses a navigation unless it passes, in order:
 *   1. WHATWG-parseable target with an http/https scheme,
 *   2. origin-lock — the target host must equal the profile baseUrl host, and
 *   3. a classification-aware check on every resolved IP.
 *
 * The origin-lock (step 2) is the PRIMARY, non-racy defense: an agent-authored
 * DSL can only ever navigate to the profile's own host, which blocks every
 * cross-host pivot (cloud-metadata IPs, other internal services, etc.).
 *
 * TOCTOU / DNS-rebinding: step 3 resolves the hostname and range-checks the
 * result, but Playwright re-resolves the hostname when it connects. A rebinding
 * attacker could therefore return a safe IP here and a hostile IP at connect
 * time. Playwright cannot easily be pinned to the IP we validated, so this IP
 * check is best-effort defense-in-depth layered on top of the origin-lock — it
 * is deliberately NOT relied upon as the sole barrier.
 */

const navigationClassifications = ["local", "test", "staging", "production"] as const;
export type NavigationClassification = (typeof navigationClassifications)[number];
export type NavigationPolicy = { baseUrl: string; classification: NavigationClassification };

/** Injectable hostname resolver; unit tests supply a fake so no real DNS is issued. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

/**
 * The lane-1 safety context threaded from the runtime into the DSL executor.
 * Designed to grow: a later lane-1 task adds an `uploadRoot` field here.
 */
export type LaneSafetyContext = { navigation: NavigationPolicy };

/** Default resolver: Node DNS. A numeric IP short-circuits without network I/O. */
export const defaultResolveHostIps: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
};

export function isNavigationClassification(value: unknown): value is NavigationClassification {
  return typeof value === "string" && (navigationClassifications as readonly string[]).includes(value);
}

/**
 * Builds a navigation policy from a registered environment-profile value, failing
 * CLOSED: a missing or malformed profile yields an unusable policy (empty baseUrl,
 * most-restrictive classification) so `assertNavigable` refuses every navigation
 * rather than defaulting to permissive.
 */
export function navigationPolicyFromProfile(profile: unknown): NavigationPolicy {
  if (isRecord(profile) && typeof profile.baseUrl === "string" && isNavigationClassification(profile.classification)) {
    return { baseUrl: profile.baseUrl, classification: profile.classification };
  }
  return { baseUrl: "", classification: "production" };
}

type Ipv4 = readonly [number, number, number, number];
type ParsedIp = { kind: "v4"; bytes: Ipv4 } | { kind: "v6"; bytes: readonly number[] };

function parseIpv4(text: string): Ipv4 | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return [a, b, c, d];
}

function parseIpv6(text: string): readonly number[] | null {
  let input = text;
  const zoneIndex = input.indexOf("%");
  if (zoneIndex !== -1) input = input.slice(0, zoneIndex);
  if (!input.includes(":")) return null;

  // Rewrite a trailing embedded IPv4 (e.g. ::ffff:169.254.169.254) into two hex groups.
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    if (lastColon === -1) return null;
    const embedded = parseIpv4(input.slice(lastColon + 1));
    if (embedded === null) return null;
    const [a, b, c, d] = embedded;
    input = `${input.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups: number[] = [];
    for (const group of segment.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };

  let groups: number[];
  if (halves.length === 2) {
    const head = parseGroups(halves[0] ?? "");
    const tail = parseGroups(halves[1] ?? "");
    if (head === null || tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<number>(missing).fill(0), ...tail];
  } else {
    const only = parseGroups(input);
    if (only === null) return null;
    groups = only;
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) bytes.push((group >> 8) & 0xff, group & 0xff);
  return bytes;
}

function parseIp(ip: string): ParsedIp | null {
  const v4 = parseIpv4(ip);
  if (v4 !== null) return { kind: "v4", bytes: v4 };
  const v6 = parseIpv6(ip);
  if (v6 !== null) return { kind: "v6", bytes: v6 };
  return null;
}

/** Extracts the embedded IPv4 of an IPv4-mapped IPv6 address (::ffff:a.b.c.d), else null. */
function embeddedIpv4(bytes: readonly number[]): Ipv4 | null {
  const mappedPrefix = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (!mappedPrefix) return null;
  const [a = 0, b = 0, c = 0, d = 0] = bytes.slice(12, 16);
  return [a, b, c, d];
}

/**
 * The low 32 bits of a deprecated IPv4-COMPATIBLE IPv6 address (`::a.b.c.d`, high
 * 96 bits all zero — RFC 4291 §2.5.5.1), as a 4-octet tuple; null otherwise.
 * NOTE this also matches `::` (low32 == 0) and `::1` (low32 == 1); callers must
 * exclude those — `::` is the unspecified address and `::1` is IPv6 loopback.
 */
function ipv4CompatibleLow32(bytes: readonly number[]): Ipv4 | null {
  if (!bytes.slice(0, 12).every((byte) => byte === 0)) return null;
  const [a = 0, b = 0, c = 0, d = 0] = bytes.slice(12, 16);
  return [a, b, c, d];
}

// --- IPv4 range predicates (operate on normalized 4-octet tuples) ---

function isThisHostNetworkV4([a]: Ipv4): boolean {
  return a === 0; // 0.0.0.0/8 "this host on this network" (RFC 1122 §3.2.1.3); includes the 0.0.0.0 unspecified address
}

function isMetadataOrLinkLocalV4([a, b]: Ipv4): boolean {
  return a === 169 && b === 254; // 169.254.0.0/16 (includes cloud-metadata 169.254.169.254)
}

function isLoopbackV4([a]: Ipv4): boolean {
  return a === 127; // 127.0.0.0/8
}

function isPrivateV4([a, b]: Ipv4): boolean {
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
  return false;
}

/**
 * True for addresses that are NEVER a legitimate QA navigation target, in every
 * classification: cloud-metadata / IPv4 link-local (169.254.0.0/16), the
 * 0.0.0.0/8 this-host network (incl. the 0.0.0.0 unspecified address) and IPv6
 * `::`, IPv6 link-local (fe80::/10), deprecated IPv4-compatible IPv6 (::a.b.c.d),
 * and the IPv4-mapped forms of these. An unparseable value is treated
 * conservatively as blocked (guards against a misbehaving injected resolver).
 */
function isBlockedAlwaysV4(bytes: Ipv4): boolean {
  return isThisHostNetworkV4(bytes) || isMetadataOrLinkLocalV4(bytes);
}

export function isBlockedAlways(ip: string): boolean {
  const parsed = parseIp(ip);
  if (parsed === null) return true;
  if (parsed.kind === "v4") return isBlockedAlwaysV4(parsed.bytes);
  const embedded = embeddedIpv4(parsed.bytes);
  if (embedded !== null) return isBlockedAlwaysV4(embedded);
  if (parsed.bytes.every((byte) => byte === 0)) return true; // :: unspecified (low32 == 0)
  // Deprecated IPv4-compatible IPv6 (::a.b.c.d, high 96 bits zero — RFC 4291 §2.5.5.1): never a
  // legitimate QA target, so block unconditionally. `::` (low32 == 0) is handled above as unspecified;
  // `::1` (low32 == 1) is IPv6 loopback and must stay classification-aware via isPrivateOrLoopback.
  const compat = ipv4CompatibleLow32(parsed.bytes);
  if (compat !== null && !(compat[0] === 0 && compat[1] === 0 && compat[2] === 0 && compat[3] === 1)) return true;
  return parsed.bytes[0] === 0xfe && ((parsed.bytes[1] ?? 0) & 0xc0) === 0x80; // fe80::/10 link-local
}

/**
 * True for loopback (127.0.0.0/8, ::1), RFC1918 private (10/8, 172.16/12,
 * 192.168/16), carrier-grade NAT (100.64/10), IPv6 unique-local (fc00::/7), and
 * the IPv4-mapped forms of these. Rejected only for staging/production; allowed
 * for local/test where exercising a local dev server is the point.
 */
export function isPrivateOrLoopback(ip: string): boolean {
  const parsed = parseIp(ip);
  if (parsed === null) return true;
  if (parsed.kind === "v4") return isLoopbackV4(parsed.bytes) || isPrivateV4(parsed.bytes);
  const embedded = embeddedIpv4(parsed.bytes);
  if (embedded !== null) return isLoopbackV4(embedded) || isPrivateV4(embedded);
  if (parsed.bytes.slice(0, 15).every((byte) => byte === 0) && parsed.bytes[15] === 1) return true; // ::1 loopback
  return ((parsed.bytes[0] ?? 0) & 0xfe) === 0xfc; // fc00::/7 unique-local
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function refuse(reason: string): never {
  throw new QaSkillsError(`Navigation refused: ${reason}`, "UNSAFE_NAVIGATION");
}

export async function assertNavigable(target: string, policy: NavigationPolicy, resolveHostIps: HostResolver = defaultResolveHostIps): Promise<void> {
  let base: URL;
  try {
    base = new URL(policy.baseUrl);
  } catch {
    refuse(`environment profile baseUrl is not a valid URL (${JSON.stringify(policy.baseUrl)})`);
  }

  let url: URL;
  try {
    url = new URL(target, base);
  } catch {
    refuse(`target is not a parseable URL (${JSON.stringify(target)})`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    refuse(`scheme ${url.protocol} is not allowed (only http and https)`);
  }

  if (url.hostname.toLowerCase() !== base.hostname.toLowerCase()) {
    refuse(`cross-host navigation from ${base.hostname} to ${url.hostname} is denied`);
  }

  const hostname = normalizeHostname(url.hostname);
  const ips = await resolveHostIps(hostname);
  if (ips.length === 0) refuse(`host ${url.hostname} did not resolve to any IP address`);

  const denyPrivate = policy.classification === "staging" || policy.classification === "production";
  for (const ip of ips) {
    if (parseIp(ip) === null) refuse(`host ${url.hostname} resolved to an unparseable address (${JSON.stringify(ip)})`);
    if (isBlockedAlways(ip)) refuse(`host ${url.hostname} resolves to a blocked metadata/link-local/unspecified address (${ip})`);
    if (denyPrivate && isPrivateOrLoopback(ip)) refuse(`host ${url.hostname} resolves to a private/loopback address (${ip}) which is denied for ${policy.classification}`);
  }
}

import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { executeAction } from "../../src/browser/playwright/executor.js";
import { QaSkillsError } from "../../src/core/errors.js";
import {
  assertNavigable,
  isBlockedAlways,
  isPrivateOrLoopback,
  navigationPolicyFromProfile,
  type HostResolver,
  type NavigationClassification,
  type NavigationPolicy,
} from "../../src/safety/navigation.js";

const resolvesTo = (ips: readonly string[]): HostResolver => () => Promise.resolve(ips);
const allClassifications: readonly NavigationClassification[] = ["local", "test", "staging", "production"];
const sameHostPolicy = (classification: NavigationClassification): NavigationPolicy => ({ baseUrl: "https://app.example.test", classification });

/** Runs `fn`, asserts it refused with a QaSkillsError(UNSAFE_NAVIGATION), and returns the error for message assertions. */
async function refusal(fn: () => Promise<unknown>): Promise<QaSkillsError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(QaSkillsError);
    expect((error as QaSkillsError).code).toBe("UNSAFE_NAVIGATION");
    return error as QaSkillsError;
  }
  throw new Error("expected assertNavigable to refuse but it resolved");
}

describe("assertNavigable scheme + origin-lock", () => {
  it("rejects every non-http/https scheme by name", async () => {
    for (const target of ["file:///etc/passwd", "data:text/html,<h1>x", "javascript:alert(1)", "ws://app.example.test/socket", "blob:https://app.example.test/uuid"]) {
      const error = await refusal(() => assertNavigable(target, sameHostPolicy("local"), resolvesTo(["93.184.216.34"])));
      expect(error.message).toMatch(/scheme/i);
    }
  });

  it("rejects cross-host navigation for every classification", async () => {
    for (const classification of allClassifications) {
      const error = await refusal(() => assertNavigable("https://evil.example.test/pivot", sameHostPolicy(classification), resolvesTo(["93.184.216.34"])));
      expect(error.message).toMatch(/host/i);
    }
  });

  it("rejects an unparseable target", async () => {
    const error = await refusal(() => assertNavigable("http://[::1", sameHostPolicy("local"), resolvesTo(["93.184.216.34"])));
    expect(error.message).toMatch(/pars|url/i);
  });
});

describe("assertNavigable always-blocked IP ranges (all classifications)", () => {
  it("rejects cloud-metadata 169.254.169.254 and IPv4 link-local even when classification=local", async () => {
    for (const ip of ["169.254.169.254", "169.254.1.1"]) {
      const policy: NavigationPolicy = { baseUrl: `http://${ip}`, classification: "local" };
      const error = await refusal(() => assertNavigable(`http://${ip}/latest/meta-data`, policy, resolvesTo([ip])));
      expect(error.message).toMatch(/metadata|link-local|blocked/i);
    }
  });

  it("rejects IPv6 link-local fe80::1 and IPv4-mapped ::ffff:169.254.169.254 even when classification=local", async () => {
    for (const ip of ["fe80::1", "::ffff:169.254.169.254"]) {
      const error = await refusal(() => assertNavigable("https://app.example.test/", sameHostPolicy("local"), resolvesTo([ip])));
      expect(error.message).toMatch(/metadata|link-local|blocked/i);
    }
  });

  it("rejects the unspecified addresses 0.0.0.0 and :: for every classification", async () => {
    for (const classification of allClassifications) {
      for (const ip of ["0.0.0.0", "::"]) {
        await refusal(() => assertNavigable("https://app.example.test/", sameHostPolicy(classification), resolvesTo([ip])));
      }
    }
  });

  it("rejects when even one of several resolved IPs is in the always-blocked set", async () => {
    await refusal(() => assertNavigable("https://app.example.test/", sameHostPolicy("local"), resolvesTo(["93.184.216.34", "169.254.169.254"])));
  });
});

describe("assertNavigable IPv4-compatible IPv6 + 0.0.0.0/8 (Finding 1 + 2 fixes)", () => {
  it("blocks IPv4-compatible ::169.254.169.254 (embedded cloud-metadata) for EVERY classification", async () => {
    for (const classification of allClassifications) {
      const error = await refusal(() => assertNavigable("https://app.example.test/", sameHostPolicy(classification), resolvesTo(["::169.254.169.254"])));
      expect(error.message).toMatch(/blocked|metadata|link-local/i);
    }
  });

  it("blocks IPv4-compatible ::127.0.0.1 (deprecated form — NOT treated as friendly loopback) for EVERY classification", async () => {
    for (const classification of allClassifications) {
      await refusal(() => assertNavigable("https://app.example.test/", sameHostPolicy(classification), resolvesTo(["::127.0.0.1"])));
    }
  });

  it("keeps ::1 IPv6 loopback classified: ALLOWED for local/test, BLOCKED for staging/production (ordering regression lock)", async () => {
    for (const classification of ["local", "test"] as const) {
      await expect(assertNavigable("https://app.example.test/", sameHostPolicy(classification), resolvesTo(["::1"]))).resolves.toBeUndefined();
    }
    for (const classification of ["staging", "production"] as const) {
      const error = await refusal(() => assertNavigable("https://app.example.test/", sameHostPolicy(classification), resolvesTo(["::1"])));
      expect(error.message).toMatch(/private|loopback/i);
    }
  });

  it("keeps :: (unspecified) always-blocked for EVERY classification (not caught by the new compatible rule)", async () => {
    for (const classification of allClassifications) {
      await refusal(() => assertNavigable("https://app.example.test/", sameHostPolicy(classification), resolvesTo(["::"])));
    }
  });

  it("blocks the whole 0.0.0.0/8 this-host network (0.1.2.3, 0.0.0.1) for EVERY classification", async () => {
    for (const classification of allClassifications) {
      for (const ip of ["0.1.2.3", "0.0.0.1"]) {
        await refusal(() => assertNavigable("https://app.example.test/", sameHostPolicy(classification), resolvesTo([ip])));
      }
    }
  });

  it("still allows 172.15.255.255 (just below RFC1918 172.16/12) for production — no boundary regression", async () => {
    await expect(assertNavigable("https://app.example.test/", sameHostPolicy("production"), resolvesTo(["172.15.255.255"]))).resolves.toBeUndefined();
  });
});

describe("assertNavigable private/loopback ranges (staging + production only)", () => {
  const privateIps = ["127.0.0.1", "10.0.0.5", "192.168.1.10", "172.16.0.1", "100.64.0.1", "::1", "fc00::1", "::ffff:10.0.0.5"];

  it("rejects loopback/RFC1918/CGNAT/unique-local for staging and production", async () => {
    for (const classification of ["staging", "production"] as const) {
      for (const ip of privateIps) {
        const error = await refusal(() => assertNavigable("https://app.example.test/", sameHostPolicy(classification), resolvesTo([ip])));
        expect(error.message).toMatch(/private|loopback/i);
        expect(error.message).toContain(classification);
      }
    }
  });

  it("allows loopback and RFC1918 for local and test", async () => {
    for (const classification of ["local", "test"] as const) {
      for (const ip of ["127.0.0.1", "192.168.1.10", "10.0.0.5"]) {
        await expect(assertNavigable("https://app.example.test/", sameHostPolicy(classification), resolvesTo([ip]))).resolves.toBeUndefined();
      }
    }
  });

  it("allows a public IP even for production", async () => {
    await expect(assertNavigable("https://app.example.test/path", sameHostPolicy("production"), resolvesTo(["93.184.216.34"]))).resolves.toBeUndefined();
  });
});

describe("assertNavigable resolver edge cases", () => {
  it("rejects when the host resolves to no IP address", async () => {
    const error = await refusal(() => assertNavigable("https://app.example.test/", sameHostPolicy("test"), resolvesTo([])));
    expect(error.message).toMatch(/resolve|IP/i);
  });

  it("rejects conservatively when a resolved value is not a parseable IP", async () => {
    const error = await refusal(() => assertNavigable("https://app.example.test/", sameHostPolicy("test"), resolvesTo(["not-an-ip"])));
    expect(error.message).toMatch(/unparseable|address/i);
  });

  it("uses the default DNS resolver when none is injected (127.0.0.1 needs no network)", async () => {
    await expect(assertNavigable("http://127.0.0.1/health", { baseUrl: "http://127.0.0.1", classification: "test" })).resolves.toBeUndefined();
  });
});

describe("navigationPolicyFromProfile fail-closed", () => {
  it("derives a policy from a valid environment profile", () => {
    expect(navigationPolicyFromProfile({ baseUrl: "https://staging.example.test", classification: "staging" })).toEqual({ baseUrl: "https://staging.example.test", classification: "staging" });
  });

  it("fails closed to an unreachable production policy for a missing/malformed profile", async () => {
    for (const profile of [undefined, null, {}, { baseUrl: 123, classification: "local" }, { baseUrl: "https://x.test", classification: "prod" }, { baseUrl: "https://x.test" }]) {
      const policy = navigationPolicyFromProfile(profile);
      expect(policy).toEqual({ baseUrl: "", classification: "production" });
      // The empty baseUrl makes every subsequent navigation refuse.
      await refusal(() => assertNavigable("https://x.test/", policy, resolvesTo(["93.184.216.34"])));
    }
  });
});

describe("isBlockedAlways / isPrivateOrLoopback helpers", () => {
  it("classifies always-blocked addresses (v4, v6, IPv4-mapped)", () => {
    for (const ip of [
      "169.254.169.254", "169.254.0.1", "0.0.0.0", "::", "fe80::1", "fe80::abcd:1", "febf::1", "::ffff:169.254.169.254", "::ffff:0.0.0.0",
      // Finding 1: deprecated IPv4-compatible IPv6 (::a.b.c.d, high 96 bits zero, low32 ∉ {0,1}) is always-blocked.
      "::169.254.169.254", "::127.0.0.1", "::0.1.2.3",
      // Finding 2: the whole 0.0.0.0/8 this-host network (incl. the embedded/mapped path).
      "0.1.2.3", "0.0.0.1", "::ffff:0.1.2.3",
    ]) {
      expect(isBlockedAlways(ip)).toBe(true);
    }
    // ::1 (IPv6 loopback) MUST NOT be caught by the compatible rule — it stays classification-aware loopback.
    for (const ip of ["93.184.216.34", "127.0.0.1", "10.0.0.1", "::1", "2606:2800:220:1:248:1893:25c8:1946"]) {
      expect(isBlockedAlways(ip)).toBe(false);
    }
    // A misbehaving resolver value is treated conservatively as blocked.
    expect(isBlockedAlways("garbage")).toBe(true);
  });

  it("classifies private/loopback addresses (v4, v6, IPv4-mapped)", () => {
    for (const ip of ["127.0.0.1", "127.255.255.254", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.10", "100.64.0.1", "::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:192.168.0.1"]) {
      expect(isPrivateOrLoopback(ip)).toBe(true);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:2800:220:1:248:1893:25c8:1946"]) {
      expect(isPrivateOrLoopback(ip)).toBe(false);
    }
  });
});

describe("DSL open path wiring", () => {
  function fakePage(): { page: Page; gotoCalls: string[] } {
    const gotoCalls: string[] = [];
    const page = { goto: (url: string) => { gotoCalls.push(url); return Promise.resolve(null); } } as unknown as Page;
    return { page, gotoCalls };
  }

  it("refuses a disallowed navigation through executeAction and never calls page.goto (no network)", async () => {
    const { page, gotoCalls } = fakePage();
    const error = await refusal(() => executeAction(page, { kind: "open", url: "https://evil.example.test/pivot" }, undefined, { navigation: { baseUrl: "https://app.example.test", classification: "test" } }));
    expect(error.message).toMatch(/host/i);
    expect(gotoCalls).toEqual([]);
  });

  it("fails closed when no lane-1 safety context is supplied to the open step", async () => {
    const { page, gotoCalls } = fakePage();
    await refusal(() => executeAction(page, { kind: "open", url: "https://app.example.test/" }, undefined));
    expect(gotoCalls).toEqual([]);
  });
});

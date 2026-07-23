import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentRoot } from "../../src/installer/agents.js";

describe("agent install roots", () => {
  it("uses pure Windows path semantics for every supported agent and scope", () => {
    expect(resolveAgentRoot("codex", "project", { projectRoot: "C:\\work\\app", userHome: "C:\\Users\\qa", pathApi: path.win32 })).toBe("C:\\work\\app\\.codex\\skills");
    expect(resolveAgentRoot("claude", "user", { projectRoot: "C:\\work\\app", userHome: "C:\\Users\\qa", pathApi: path.win32 })).toBe("C:\\Users\\qa\\.claude\\skills");
    expect(resolveAgentRoot("cursor", "project", { projectRoot: "C:\\work\\app", userHome: "C:\\Users\\qa", pathApi: path.win32 })).toBe("C:\\work\\app\\.cursor\\skills");
  });
});

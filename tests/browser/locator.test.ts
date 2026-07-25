import { expect, describe, it } from "vitest";

import { locatorKind, resolveLocator } from "../../src/browser/locator.js";
import { validateBrowserTestDsl } from "../../src/contracts/validator.js";

describe("resolveLocator", () => {
  it("uses the deterministic semantic locator priority", () => {
    const calls: string[] = [];
    const page = {
      getByRole: () => { calls.push("role"); return "role"; },
      getByTestId: () => { calls.push("testId"); return "testId"; },
      getByLabel: () => { calls.push("label"); return "label"; },
      getByPlaceholder: () => { calls.push("placeholder"); return "placeholder"; },
      getByText: () => { calls.push("text"); return "text"; },
      locator: () => { calls.push("css"); return "css"; },
    };

    expect(resolveLocator(page as never, { role: "button", name: "Save" })).toBe("role");
    expect(calls).toEqual(["role"]);
    expect(locatorKind({ testId: "save" })).toBe("testId");
  });

  it("rejects XPath, evaluate, and selectors outside the bounded DSL", () => {
    expect(() => resolveLocator({} as never, { css: "//button" })).toThrow(/XPath/i);
    expect(() => resolveLocator({} as never, { evaluate: "document.cookie" } as never)).toThrow(/unsupported/i);
    expect(() => resolveLocator({ locator: () => "css" } as never, { css: "button" })).not.toThrow();
    expect(() => resolveLocator({} as never, { role: "button", testId: "save" })).toThrow(/exactly one/i);
  });
});

describe("browser test DSL", () => {
  it("permits only bounded actions and assertions", () => {
    expect(validateBrowserTestDsl({
      steps: [{ id: "open", action: { kind: "open", url: "https://example.test" }, sideEffect: "none", assertions: [{ kind: "url", url: "https://example.test" }] }],
    }).valid).toBe(true);
    expect(validateBrowserTestDsl({
      steps: [{ id: "script", action: { kind: "evaluate", script: "document.cookie" }, sideEffect: "none" }],
    }).valid).toBe(false);
  });

  it("accepts exactly one locator kind and rejects a dangling name", () => {
    expect(validateBrowserTestDsl({ steps: [{ id: "one", action: { kind: "click", locator: { role: "button", name: "Save" } }, sideEffect: "none" }] }).valid).toBe(true);
    expect(validateBrowserTestDsl({ steps: [{ id: "two", action: { kind: "click", locator: { name: "Save" } }, sideEffect: "none" }] }).valid).toBe(false);
    expect(validateBrowserTestDsl({ steps: [{ id: "three", action: { kind: "click", locator: { role: "button", testId: "save" } }, sideEffect: "none" }] }).valid).toBe(false);
  });

  function uploadStep(sideEffect: string) {
    return { steps: [{ id: "upload", action: { kind: "upload", locator: { label: "Attachment" }, files: ["fixture.txt"] }, sideEffect }] };
  }

  it("forces an upload step to a non-`none` side effect so uploads route through authorization", () => {
    // `none` bypasses `authorizeStep`, so it is rejected for uploads (a real, authorization-bearing side effect).
    expect(validateBrowserTestDsl(uploadStep("none")).valid).toBe(false);
    // Every real side-effect class is accepted at the schema level.
    expect(validateBrowserTestDsl(uploadStep("reversible")).valid).toBe(true);
    expect(validateBrowserTestDsl(uploadStep("external")).valid).toBe(true);
    expect(validateBrowserTestDsl(uploadStep("destructive")).valid).toBe(true);
  });

  it("still permits a non-upload step to declare `sideEffect: none` (the conditional is upload-only)", () => {
    expect(validateBrowserTestDsl({ steps: [{ id: "click", action: { kind: "click", locator: { testId: "save" } }, sideEffect: "none" }] }).valid).toBe(true);
    expect(validateBrowserTestDsl({ steps: [{ id: "open", action: { kind: "open", url: "https://example.test" }, sideEffect: "none" }] }).valid).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";

import { withDemoResources } from "../../scripts/run-demo.js";

describe("demo resource lifecycle", () => {
  it("closes the server when browser launch fails", async () => {
    const closeServer = vi.fn(() => Promise.resolve());
    await expect(withDemoResources({
      serve: () => Promise.resolve({ baseUrl: "http://127.0.0.1:1", close: closeServer }),
      launch: () => Promise.reject(new Error("launch failed")),
    }, () => Promise.resolve(undefined))).rejects.toThrow("launch failed");
    expect(closeServer).toHaveBeenCalledOnce();
  });

  it("closes the server even when browser close rejects", async () => {
    const closeServer = vi.fn(() => Promise.resolve());
    const closeBrowser = vi.fn(() => Promise.reject(new Error("browser close failed")));
    await expect(withDemoResources({
      serve: () => Promise.resolve({ baseUrl: "http://127.0.0.1:1", close: closeServer }),
      launch: () => Promise.resolve({ close: closeBrowser }),
    }, () => Promise.resolve("done"))).rejects.toThrow("browser close failed");
    expect(closeBrowser).toHaveBeenCalledOnce();
    expect(closeServer).toHaveBeenCalledOnce();
  });
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Several integration files launch a real Chromium process. Keeping files
    // serial avoids resource contention while preserving each test's normal
    // timeout and assertions.
    fileParallelism: false,
  },
});

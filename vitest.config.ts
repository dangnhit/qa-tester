import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Several integration files launch a real Chromium process. Keeping files
    // serial avoids resource contention while preserving each test's normal
    // timeout and assertions.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "tests/**",
        "scripts/**",
        "fixtures/**",
        "dist/**",
        "src/contracts/generated/**",
        "**/*.config.*",
        "**/*.d.ts",
      ],
      // Conservative floor set at/below the coverage measured when this was added
      // (measured: statements 90.84%, branches 81.09%, functions 96.32%, lines
      // 90.84% — see task-8-report.md). This is a ratchet baseline, not a target;
      // raise it deliberately as coverage improves, never lower it to make CI pass.
      thresholds: {
        lines: 90,
        functions: 95,
        branches: 80,
        statements: 90,
      },
    },
  },
});

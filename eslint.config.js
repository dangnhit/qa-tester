import eslint from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "src/contracts/generated/**", "coverage/**", "eslint.config.js"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
    },
    settings: {
      // .js-extension imports resolve to .ts sources under NodeNext — the
      // TypeScript resolver (not the default `node` resolver) is required
      // for import/no-cycle and import/no-restricted-paths to see them.
      "import/resolver": {
        typescript: {
          project: "./tsconfig.json",
        },
      },
      // import/no-cycle parses each resolved dependency file to walk its
      // imports; without this it uses the default JS parser (espree) on
      // .ts files, which fails to parse TS syntax and silently breaks
      // graph traversal.
      "import/parsers": {
        "@typescript-eslint/parser": [".ts", ".cts", ".mts", ".tsx"],
      },
    },
    rules: {
      // Locks in the acyclic import graph established in Phase 2
      // (`madge --circular` is clean at 138 files). Type-only imports
      // (`import type`, `export type ... from`) are ignored by this rule,
      // so the run-workspace re-export of ArtifactRecord does not need an
      // accommodation.
      "import/no-cycle": "error",
      // Locks in the Phase 2 layering fix: core must stay below
      // orchestration/operations in the dependency graph. Deliberately
      // narrow — does NOT constrain the legitimate core -> contracts /
      // planning / regression / reporting / retest / defects edges.
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            { target: "./src/core", from: "./src/orchestration" },
            { target: "./src/core", from: "./src/operations" },
          ],
        },
      ],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
);

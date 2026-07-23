# Task 1 Report: Project Toolchain and Contract Foundation

## Implementation summary

- Added the strict ESM TypeScript/npm toolchain for `@vigentix/qa-skills`, including the required scripts, Node `>=22` engine, Vitest, ESLint, and committed npm lockfile.
- Added ten canonical Draft 2020-12 JSON Schemas with per-artifact `1.0.0` envelope versions, strict object roots, required fields, and the specified status, classification, side-effect, and release enums.
- Added a single AJV 2020 schema catalog that compiles every schema once, plus non-mutating artifact validation with normalized errors.
- Added JSON/YAML authoring parsing that rejects non-object roots and multi-document YAML, UTC timestamps, cryptographically suffixed UTC run IDs, and ULID entity IDs.
- Added deterministic generated declaration output for each schema and drift checking.

## Files

- Tooling: `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`
- Contracts: `src/contracts/types.ts`, `src/contracts/catalog.ts`, `src/contracts/validator.ts`, `src/contracts/authoring.ts`, `src/contracts/generated/*.d.ts`
- Core helpers: `src/core/errors.ts`, `src/core/ids.ts`, `src/core/time.ts`
- Generator: `scripts/generate-types.ts`
- Schemas: `shared/schemas/*.schema.json` (ten artifact contracts)
- Tests: `tests/contracts/validator.test.ts`, `tests/contracts/authoring.test.ts`, `tests/core/ids.test.ts`

## RED evidence

Command:

```text
npm test -- tests/contracts/validator.test.ts tests/contracts/authoring.test.ts tests/core/ids.test.ts
```

Before the toolchain existed it exited `254` with `ENOENT` because `package.json` did not exist. After adding only the test toolchain, the same command exited `1`: all three suites failed during collection with the expected missing-module errors for `src/contracts/validator.js`, `src/contracts/authoring.js`, and `src/core/ids.js`.

## GREEN evidence

Focused command:

```text
npm test -- tests/contracts/validator.test.ts tests/contracts/authoring.test.ts tests/core/ids.test.ts
```

Exited `0`: 3 test files passed, 7 tests passed.

Required final commands all exited `0` without warnings:

```text
npm run generate:types
npm test -- tests/contracts/validator.test.ts tests/contracts/authoring.test.ts tests/core/ids.test.ts
npm run typecheck
npm run lint
```

Additional final checks all exited `0`:

```text
npm test                         # 3 files, 7 tests passed
npm run build
npm run check:generated
git diff --check
```

The schema header review also exited `0` and confirmed all 10 schemas declare Draft 2020-12, object root type, `additionalProperties: false`, required fields, and `schemaVersion: 1.0.0`.

## Self-review

- Verified run IDs use UTC components and `crypto.randomBytes(3)` for exactly six lowercase hexadecimal characters.
- Verified entity IDs use the `ulid` package and authoring parser accepts only object roots without repairing input.
- Verified AJV is configured without coercion/default application, so validation does not mutate caller input.
- Verified generated declarations are current and tracked by the drift check.
- No outstanding Task 1 concerns found.

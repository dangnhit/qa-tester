import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(".");
const consumer = await mkdtemp(join(tmpdir(), "qa-skills-consumer-"));
const run = (command: string, args: string[], cwd = root): string => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};

let tarball: string | undefined;
try {
  run("npm", ["run", "build"]);
  const packed = JSON.parse(run("npm", ["pack", "--json"])) as { filename: string; files: { path: string }[] }[];
  const packageResult = packed[0];
  if (packageResult === undefined) throw new Error("npm pack did not return a package result");
  const forbidden = packageResult.files.map((file) => file.path).filter((path) => /^(tests|fixtures|scripts)\//.test(path));
  if (forbidden.length > 0) throw new Error(`tarball contains development-only files: ${forbidden.join(", ")}`);
  tarball = join(root, packageResult.filename);
  run("npm", ["init", "-y"], consumer);
  run("npm", ["install", tarball, "--ignore-scripts"], consumer);
  // Type-checks AND (below, after the tsc run) actually EXECUTES every name `.` re-exports (the
  // whole public value+type surface, src/orchestration/qa-tester.ts) plus the "./cli" subpath, at the
  // one packaging boundary where a consumer's own build and `import` are what would catch a name that
  // resolves in the source tree but not from the installed tarball. This used to import only
  // `createQaTester` -- one name out of forty-eight -- which is not a smoke test of "the public API
  // installs correctly," just of one function in it. Values and types are two separate
  // `import`/`import type` statements because they are proven two different ways: the 42 types have
  // no runtime shape, so naming them in an `import type` and letting `tsc` resolve each against the
  // installed package's `.d.ts` (failing with "has no exported member" the moment one is missing) IS
  // the whole assertion for those. The 6 values get that same `.d.ts` check AND, because `tsc --noEmit`
  // emits no JS and this script never previously ran the file, a second and different failure mode:
  // the `typeof`/`Array.isArray` checks below only prove anything once `consumer.mts` is actually
  // executed, which happens after the `tsc` invocation.
  const consumerSource = `import {
  createQaTester, qaTester, TestDataHookRegistry, ExternalPermitRegistry,
  selectRegressionCases, regressionMappingSources,
} from "@vigentix/qa-skills";
import type {
  QaRuntimeRegistry, QaWorkflowInput, WorkflowResult, WorkflowOutput, WorkflowTerminalStatus,
  WorkflowOperationInputMap, WorkflowOperationOutputMap, CorrelatedWorkflowOutputs,
  CanonicalPlanBundleRef, RegisteredArtifactRef, PendingHumanInput, PendingHumanInputSubject,
  PendingObservedExecution, RetestScenario, RetestSource, PublicWorkflowMode, WorkflowOperationName,
  WorkspaceValidation, WorkspaceDiagnostic, ArtifactRecord, ReleaseRecommendation, ExplorationCharter,
  ExplorationAction, SecretResolver, TelemetryFinding, EvidencePolicyLayers, EvidencePolicyLayer,
  EvidenceChannel, EvidenceMode, EvidenceRedactionPolicy, TelemetryScrubber, TelemetryPayload,
  TestDataHookDescriptor, HookRunners, ProducedResource, ExternalPermit, ChangeScope, RegressionCase,
  RegressionDecision, RegressionSelection, RegressionSource, UnmappedChangeRisk,
} from "@vigentix/qa-skills";
// Type-only namespace import: proves the "./cli" subpath resolves to a real declaration file at the
// packaging boundary without importing a VALUE from it. "./cli" compiles to the same file
// bin.qa-skill points at (src/cli/index.ts) and runs the CLI as a side effect the instant it is
// imported as a value -- see "What v1.0 freezes" in the README. \`import type * as\` is erased before
// EITHER consumer of this source below evaluates the module -- \`tsc --noEmit\` (never emits JS) and
// \`tsx\` (elides \`import type\` as a syntax-level TypeScript construct, confirmed by measurement, see
// the comment beside the \`tsx\` invocation) -- so this line can only ever fail by not type-checking,
// never by running the CLI mid-smoke-test.
import type * as QaSkillsCli from "@vigentix/qa-skills/cli";
type CliSubpathHasTypes = typeof QaSkillsCli;

if (typeof createQaTester !== "function") throw new Error("missing public API: createQaTester");
if (typeof qaTester !== "function") throw new Error("missing public API: qaTester");
if (typeof TestDataHookRegistry !== "function") throw new Error("missing public API: TestDataHookRegistry");
if (typeof ExternalPermitRegistry !== "function") throw new Error("missing public API: ExternalPermitRegistry");
if (typeof selectRegressionCases !== "function") throw new Error("missing public API: selectRegressionCases");
if (!Array.isArray(regressionMappingSources)) throw new Error("missing public API: regressionMappingSources");
process.stdout.write("consumer.mts: all 6 public values present with the expected runtime shape\\n");
`;
  await writeFile(join(consumer, "consumer.mts"), consumerSource);
  run(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"), "consumer.mts", "--noEmit", "--strict",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ESNext",
    "--lib", "ESNext,DOM", "--types", "node", "--typeRoots", join(root, "node_modules", "@types"),
  ], consumer);
  // `tsc --noEmit` above only PROVES every name resolves in the installed package's `.d.ts` -- it
  // emits no JS and nothing in this script ever ran the file, so the `if (typeof ... ) throw` lines
  // above never executed and could not have caught a value present in the `.d.ts` but missing (or
  // wrong-shaped) in the shipped `.js`. Confirmed by mutation: deleting a value's `export` from the
  // built `.js` while leaving the `.d.ts` untouched left this smoke test green before this fix.
  //
  // `consumer.mts` mixes `import type * as QaSkillsCli from "@vigentix/qa-skills/cli"` in with real
  // value imports, so actually EXECUTING the file must not run "./cli" as a side effect (see "What
  // v1.0 freezes" in the README on why importing it as a value does). Measured, not assumed: a probe
  // file with `import type * as X from "<module-with-a-console.log-side-effect>"` printed nothing
  // under both plain `node` (v22.6+/24, native type-stripping) and `tsx` (esbuild-based, used here) --
  // `import type` is a syntax-level TypeScript construct erased before either ever evaluates the
  // module. Run through `tsx` (already this project's own devDependency for running THIS script, not
  // a new one) rather than bare `node --experimental-strip-types`: `tsx` does not depend on which
  // Node minor first shipped default type-stripping, so it runs identically on every Node line this
  // package's `engines` field admits (>=22), not only the Node 24 leg CI gates `smoke:package` behind.
  run(join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx"), ["consumer.mts"], consumer);
  const installedPackageRoot = join(consumer, "node_modules", "@vigentix", "qa-skills");
  const installed = JSON.parse(await readFile(join(installedPackageRoot, "package.json"), "utf8")) as { version?: string; types?: string; private?: boolean };
  if (!installed.version) throw new Error("installed package.json is missing a version");
  if (!installed.types || installed.private === true) throw new Error("installed package metadata is not publishable and typed");

  const bin = join(consumer, "node_modules", ".bin", process.platform === "win32" ? "qa-skill.cmd" : "qa-skill");
  const version = run(bin, ["--version"], consumer).trim();
  // Compared against the tarball's own package.json rather than a hardcoded literal: this line
  // used to read `if (version !== "0.1.0")` and never tracked the two later version bumps
  // (b4d5912 to 0.2.0, 2cc7030 to 0.3.0). This was not a script that sat unexecuted between those
  // bumps and now: CI's "Pack and install in a clean typed consumer" step (ci.yml) runs it on every
  // push, and it has been red there on every push since the drift — a failing signal that went
  // unacted on, not a missing one. tests/installer/manifest.test.ts guards the same equality inside
  // the source tree (runtimeVersion vs package.json); this is the same guard at the packaging
  // boundary.
  if (version !== installed.version) throw new Error(`installed CLI --version reported "${version}", but the installed package.json version is "${installed.version}"`);

  for (const locale of ["en", "vi"]) {
    const templatePath = join(installedPackageRoot, "dist", "shared", "templates", `report.${locale}.md`);
    const template = await readFile(templatePath, "utf8").catch(() => {
      throw new Error(`installed package is missing template: ${templatePath}`);
    });
    if (template.trim().length === 0) throw new Error(`installed template is empty: ${templatePath}`);
  }

  // Unix-only: this used to be tests/cli/installed-cli.test.ts, its own vitest file gated with
  // `it.runIf(process.platform !== "win32")` because invoking the packaged .bin shim and then the
  // compiled entry point directly was never exercised on Windows. Folded in here rather than kept
  // as its own file because it packs and installs the same tarball this script already built —
  // running a second `npm run build` / `npm pack` / `npm install` cycle just to duplicate that setup
  // was the redundant part, not the assertions. This step already runs Ubuntu-only in CI
  // (`smoke:package`, Node 24 leg), so the guard only matters for a developer invoking
  // `npm run smoke:package` locally on Windows.
  if (process.platform !== "win32") {
    const cliEntry = join(installedPackageRoot, "dist", "src", "cli", "index.js");
    const cliSource = await readFile(cliEntry, "utf8");
    if (!/^#!\/usr\/bin\/env node/.test(cliSource)) throw new Error(`installed CLI entry point is missing its shebang: ${cliEntry}`);

    const verified = JSON.parse(run(bin, ["runtime", "verify", "--range", ">=1.0.0 <2.0.0"], consumer)) as { version?: string; compatible?: boolean };
    if (verified.version !== installed.version || verified.compatible !== true) {
      throw new Error(`runtime verify on the installed binary reported ${JSON.stringify(verified)}, expected version "${installed.version}" and compatible: true`);
    }

    run(bin, ["skills", "install", "--agent", "codex"], consumer);
    await rm(bin);

    const verifyAfterRemoval = spawnSync(process.execPath, [cliEntry, "skills", "verify", "--agent", "codex"], { cwd: consumer, encoding: "utf8" });
    if (verifyAfterRemoval.status !== 1) {
      throw new Error(`expected "skills verify" to exit 1 after removing the recorded runtime, got exit code ${String(verifyAfterRemoval.status)}\n${verifyAfterRemoval.stdout}${verifyAfterRemoval.stderr}`);
    }
    const removalPayload = JSON.parse(verifyAfterRemoval.stdout || "{}") as { status?: string; runtime?: { status?: string } };
    if (removalPayload.status !== "runtime-missing" || removalPayload.runtime?.status !== "runtime-missing") {
      throw new Error(`expected status "runtime-missing" after removing the recorded runtime, got ${verifyAfterRemoval.stdout}`);
    }
  }

  process.stdout.write(`clean consumer accepted @vigentix/qa-skills@${version}\n`);
} finally {
  if (tarball) await rm(tarball, { force: true });
  await rm(consumer, { recursive: true, force: true });
}

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
  await writeFile(join(consumer, "consumer.mts"), 'import { createQaTester } from "@vigentix/qa-skills";\nif (typeof createQaTester !== "function") throw new Error("missing public API");\n');
  run(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"), "consumer.mts", "--noEmit", "--strict",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ESNext",
    "--lib", "ESNext,DOM", "--types", "node", "--typeRoots", join(root, "node_modules", "@types"),
  ], consumer);
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

    const verified = JSON.parse(run(bin, ["runtime", "verify", "--range", ">=0.1.0 <1.0.0"], consumer)) as { version?: string; compatible?: boolean };
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

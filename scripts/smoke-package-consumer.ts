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
  const bin = join(consumer, "node_modules", ".bin", process.platform === "win32" ? "qa-skill.cmd" : "qa-skill");
  const version = run(bin, ["--version"], consumer).trim();
  if (version !== "0.1.0") throw new Error(`installed CLI returned ${version}`);
  const installed = JSON.parse(await readFile(join(consumer, "node_modules", "@vigentix", "qa-skills", "package.json"), "utf8")) as { types?: string; private?: boolean };
  if (!installed.types || installed.private === true) throw new Error("installed package metadata is not publishable and typed");
  process.stdout.write(`clean consumer accepted @vigentix/qa-skills@${version}\n`);
} finally {
  if (tarball) await rm(tarball, { force: true });
  await rm(consumer, { recursive: true, force: true });
}

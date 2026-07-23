import { readFile } from "node:fs/promises";

import { createRun } from "../src/operations/create-run.js";
import type { ArtifactProfileName } from "../src/core/artifact-profiles.js";

const [root, mode, environmentProfilePath] = process.argv.slice(2);
if (!root || !mode || !environmentProfilePath) throw new Error("Usage: create-run <root> <mode> <environment-profile.json>");
const environmentProfile = JSON.parse(await readFile(environmentProfilePath, "utf8")) as Record<string, unknown>;
const workspace = await createRun({ root, mode: mode as ArtifactProfileName, environmentProfile });
process.stdout.write(`${workspace.runId}\n`);

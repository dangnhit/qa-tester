import { validateRun } from "../src/operations/validate-run.js";

const [root, runId] = process.argv.slice(2);
if (!root || !runId) throw new Error("Usage: validate-artifacts <root> <run-id>");
const result = await validateRun(root, runId);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.valid ? 0 : 1;

import { parseArgs } from "node:util";

import { RunWorkspace } from "../src/core/run-workspace.js";
import { generateQaReport } from "../src/operations/generate-qa-report.js";

const { values } = parseArgs({ options: { root: { type: "string" }, run: { type: "string" }, locale: { type: "string", default: "en" } }, strict: true });
if (!values.root || !values.run || (values.locale !== "en" && values.locale !== "vi")) throw new Error("--root --run and locale en or vi are required");
const workspace = await RunWorkspace.open(values.root, values.run);
try {
  const report = await generateQaReport({ workspace, locale: values.locale });
  process.stdout.write(report.json);
} finally { await workspace.close(); }

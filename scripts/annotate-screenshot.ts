import { parseArgs } from "node:util";

import { annotateScreenshot } from "../src/evidence/annotator.js";
import { RunWorkspace } from "../src/core/run-workspace.js";

const { values } = parseArgs({ options: { root: { type: "string" }, run: { type: "string" }, raw: { type: "string" }, rawArtifact: { type: "string" }, evidence: { type: "string" }, attempt: { type: "string" }, url: { type: "string" } }, strict: true });
if (!values.root || !values.run || !values.raw || !values.rawArtifact || !values.evidence || !values.attempt || !values.url) throw new Error("--root --run --raw --rawArtifact --evidence --attempt and --url are required");
const workspace = await RunWorkspace.open(values.root, values.run);
try {
  await annotateScreenshot({ workspace, rawPath: values.raw, rawBinaryArtifactId: values.rawArtifact, provenance: { evidenceId: values.evidence, runId: workspace.runId, attemptId: values.attempt, captureType: "screenshot", dpr: 1, scroll: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 1, height: 1 }, url: values.url, viewport: { width: 1, height: 1 }, browser: "unknown", build: "unknown", capturedAt: new Date().toISOString() }, annotations: [] });
} finally { await workspace.close(); }

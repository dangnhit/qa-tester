import { parseArgs } from "node:util";

import { annotateScreenshot } from "../src/evidence/annotator.js";

const { values } = parseArgs({ options: { raw: { type: "string" }, output: { type: "string" }, evidence: { type: "string" }, run: { type: "string" }, attempt: { type: "string" }, url: { type: "string" } }, strict: true });
if (!values.raw || !values.output || !values.evidence || !values.run || !values.attempt || !values.url) throw new Error("--raw --output --evidence --run --attempt and --url are required");
await annotateScreenshot({ rawPath: values.raw, outputPath: values.output, provenance: { evidenceId: values.evidence, runId: values.run, attemptId: values.attempt, captureType: "screenshot", dpr: 1, scroll: { x: 0, y: 0 }, clip: { x: 0, y: 0, width: 1, height: 1 }, url: values.url, viewport: { width: 1, height: 1 }, browser: "unknown", build: "unknown", capturedAt: new Date().toISOString() }, annotations: [] });

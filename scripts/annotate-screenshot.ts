import { parseArgs } from "node:util";

import { annotateScreenshot } from "../src/evidence/annotator.js";
import { RunWorkspace } from "../src/core/run-workspace.js";

const { values } = parseArgs({ options: { root: { type: "string" }, run: { type: "string" }, rawDescriptor: { type: "string" }, rawArtifact: { type: "string" } }, strict: true });
if (!values.root || !values.run || !values.rawDescriptor || !values.rawArtifact) throw new Error("--root --run --rawDescriptor and --rawArtifact are required");
const workspace = await RunWorkspace.open(values.root, values.run);
try {
  await annotateScreenshot({ workspace, rawEvidenceDescriptorId: values.rawDescriptor, rawBinaryArtifactId: values.rawArtifact, annotations: [] });
} finally { await workspace.close(); }

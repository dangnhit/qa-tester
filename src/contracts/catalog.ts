import { createRequire } from "node:module";

import artifactManifestSchema from "../../shared/schemas/artifact-manifest.schema.json" with { type: "json" };
import annotationSchema from "../../shared/schemas/annotation.schema.json" with { type: "json" };
import bugReportSchema from "../../shared/schemas/bug-report.schema.json" with { type: "json" };
import incidentSchema from "../../shared/schemas/incident.schema.json" with { type: "json" };
import releaseGateSchema from "../../shared/schemas/release-gate.schema.json" with { type: "json" };
import browserTestDslSchema from "../../shared/schemas/browser-test-dsl.schema.json" with { type: "json" };
import environmentProfileSchema from "../../shared/schemas/environment-profile.schema.json" with { type: "json" };
import evidenceGapSchema from "../../shared/schemas/evidence-gap.schema.json" with { type: "json" };
import evidenceSchema from "../../shared/schemas/evidence.schema.json" with { type: "json" };
import qaExecutionReportSchema from "../../shared/schemas/qa-execution-report.schema.json" with { type: "json" };
import qaConfigSchema from "../../shared/schemas/qa-config.schema.json" with { type: "json" };
import planningActionSchema from "../../shared/schemas/planning-action.schema.json" with { type: "json" };
import coverageObligationSchema from "../../shared/schemas/coverage-obligation.schema.json" with { type: "json" };
import cleanupRunSchema from "../../shared/schemas/cleanup-run.schema.json" with { type: "json" };
import requirementAnalysisSchema from "../../shared/schemas/requirement-analysis.schema.json" with { type: "json" };
import runMetadataSchema from "../../shared/schemas/run-metadata.schema.json" with { type: "json" };
import testCaseSchema from "../../shared/schemas/test-case.schema.json" with { type: "json" };
import testDataManifestSchema from "../../shared/schemas/test-data-manifest.schema.json" with { type: "json" };
import testResultSchema from "../../shared/schemas/test-result.schema.json" with { type: "json" };
import testPlanSchema from "../../shared/schemas/test-plan.schema.json" with { type: "json" };
import testStepResultSchema from "../../shared/schemas/test-step-result.schema.json" with { type: "json" };
import type { FormatsPlugin } from "ajv-formats";
import type { Ajv2020 as Ajv2020Instance, ValidateFunction } from "ajv/dist/2020.js";

import type { ArtifactType } from "./types.js";

const schemas: Record<ArtifactType, object> = {
  "run-metadata": runMetadataSchema,
  "artifact-manifest": artifactManifestSchema,
  "environment-profile": environmentProfileSchema,
  "test-case": testCaseSchema,
  "test-step-result": testStepResultSchema,
  "test-result": testResultSchema,
  evidence: evidenceSchema,
  "evidence-gap": evidenceGapSchema,
  "bug-report": bugReportSchema,
  incident: incidentSchema,
  "release-gate": releaseGateSchema,
  "test-data-manifest": testDataManifestSchema,
  "cleanup-run": cleanupRunSchema,
  "qa-execution-report": qaExecutionReportSchema,
  "requirement-analysis": requirementAnalysisSchema,
  "coverage-obligation": coverageObligationSchema,
  "test-plan": testPlanSchema,
};

const require = createRequire(import.meta.url);
const Ajv2020 = (require("ajv/dist/2020.js") as { default: typeof Ajv2020Instance }).default;
const addFormats = (require("ajv-formats") as { default: FormatsPlugin }).default;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(browserTestDslSchema);
ajv.addSchema(planningActionSchema);

export const planningActionValidator = ajv.getSchema(planningActionSchema.$id) as ValidateFunction;
export const browserTestDslValidator = ajv.getSchema(browserTestDslSchema.$id) as ValidateFunction;
export const annotationValidator = ajv.compile(annotationSchema);
export const qaConfigValidator = ajv.compile(qaConfigSchema);

export const artifactValidators: Readonly<Record<ArtifactType, ValidateFunction>> = Object.fromEntries(
  Object.entries(schemas).map(([type, schema]) => [type, ajv.compile(schema)]),
) as Record<ArtifactType, ValidateFunction>;

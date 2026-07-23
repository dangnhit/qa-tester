import { annotateScreenshot, type AnnotatedEvidence } from "../evidence/annotator.js";
import { attachEvidence, captureEvidence, type EvidenceAttachment, type EvidenceCaptureResult } from "../evidence/collector.js";

export const collectEvidence = {
  capture: captureEvidence,
  attach: attachEvidence,
  annotate: annotateScreenshot,
} as const;

export type CollectEvidenceOperation = {
  capture: typeof captureEvidence;
  attach: typeof attachEvidence;
  annotate: (input: Parameters<typeof annotateScreenshot>[0]) => Promise<AnnotatedEvidence>;
};

export type { EvidenceAttachment, EvidenceCaptureResult };

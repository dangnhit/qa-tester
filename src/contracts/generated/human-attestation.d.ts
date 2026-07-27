/* This file is generated from shared/schemas. Do not edit manually. */

/**
 * An identified person's immutable signed claim that an evaluation no machine performed was actually carried out (CONTEXT.md:143-145). Deliberately NOT an approval-decision: that glossary entry's own _Avoid_ line names 'sign-off, approval decision' as the concepts a Human Attestation must not be confused with. An approval-decision authorises a plan; this records that a manual evaluation happened.
 */
export interface HumanAttestation {
  artifactType: "human-attestation";
  schemaVersion: "1.0.0";
  producerVersion: string;
  attestationId: string;
  runId: string;
  obligationId: string;
  /**
   * The sha256 of the registered coverage-obligation artifact this attests to. Carried for the same reason approval-decision carries planSha256: it pins the claim to the exact immutable bytes the attester saw, so a reader of the attestation alone can verify what was attested to without trusting whatever the manifest resolves later.
   */
  obligationSha256: string;
  /**
   * The manual evaluation the attester carried out. Only the manual subset of accessibilityMethod: CONTEXT.md:438 says an automated Accessibility Obligation is satisfied only by a machine-produced artifact and a manual one only by a Human Attestation, so a person attesting to 'automated-analysis' is a category error. The schema says so rather than leaving it to a rule a future producer could bypass.
   */
  method: "keyboard" | "screen-reader" | "cognitive-manual";
  /**
   * The identity of the person making the claim. 'Identified' in the glossary entry is this field plus the manifest record's human-attestation:<identity> provenance, which no agent-draft path can write.
   */
  attestedBy: string;
  attestedAt: string;
  /**
   * What the attester actually did and observed, in their own words. This is the substance of the claim: without it the artifact records only that somebody pressed a button, and a later auditor cannot tell whether the evaluation performed was the one the obligation required. The floor is well above 1 because a single-token statement ('ok', 'done') is as empty as no statement at all, and this artifact is the ONLY evidence a manual evaluation ever produces. `minLength` counts Unicode code points, not bytes or words: a terse-but-real English statement just under the floor is rejected, while a CJK statement of the same code-point length carries proportionally more content and clears it. The bound is kept as a floor despite that imprecision.
   */
  statement: string;
}

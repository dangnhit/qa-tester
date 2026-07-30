import { createHash } from "node:crypto";

import type { ProjectionModel } from "./projection-model.js";

/** The one definition of what a projection's checksum IS, so the sidecar's field and the operation's
 *  returned value cannot drift into hashing different things. Both hash the same buffer — the exact
 *  bytes written to the output file — so they can only ever agree. */
export function projectionChecksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Binds a derived file to the exact gate it projects. The projection is NOT a registered artifact — a
 * finalized run is closed — so this sidecar is the only thing that names which gate, and which source
 * artifacts, a given XML or SARIF file was projected from.
 *
 * **What it enforces, stated as what is enforced.** Neither file is signed. The sidecar is unsigned JSON
 * written beside the projection by the same command, into the same directory, with the same permissions,
 * so anyone who can edit `qa-junit.xml` can recompute the sha256 and rewrite the sidecar to match. With
 * only the two files in hand, a hand-edited XML IS indistinguishable from a real one, and any wording
 * here that suggests otherwise would be describing a mechanism this code does not have. What the pair
 * genuinely provides is INTEGRITY OF THE PAIR — a projection corrupted in transit, truncated by a CI
 * artifact store, or edited by someone who did not think to update the sidecar no longer matches its
 * `projectionSha256` — and a POINTER: `runId`, `gate.artifactId`, `gate.sha256` and `sourceArtifacts`
 * name artifacts inside a run workspace whose manifest is itself checksummed and re-verified on every
 * read (`inspect-workspace-state.ts`). A reader who still has that workspace can check the sidecar's
 * claims against it, and THAT check is what turns consistency into authenticity. A reader who has only
 * the two files cannot, and should not be told they can.
 *
 * It takes the BYTES and hashes them here rather than accepting a caller-computed digest, and that is
 * the whole point of the parameter: a sidecar that could be handed a checksum would be able to describe
 * bytes it never saw, which is precisely the claim it exists to make impossible.
 *
 * `reduced` is the ONLY field naming the protected-environment condition, and no `protectedEnvironment`
 * sits beside it. One bit under two names is a drift surface: the pair carries no information the
 * single field does not, and can only ever differ by being wrong. `reduced` is the name that says what
 * the FILE is — this is a record about a projection, not a copy of the gate's environment label, and a
 * reader asking whether the run was protected has `gate.artifactId`/`gate.sha256` to go and ask.
 *
 * Nothing here is derived a second time: `gate`, `sourceArtifacts`, `reduced`, `producerVersion` and
 * `generatedAt` are copied off the model, which copied them off the persisted gate artifact.
 */
export function renderSidecar(model: ProjectionModel, projection: "junit" | "sarif", bytes: Uint8Array): string {
  return `${JSON.stringify({
    projection,
    projectionSha256: projectionChecksum(bytes),
    runId: model.runId,
    gate: { artifactId: model.gate.artifactId, sha256: model.gate.sha256, recommendation: model.gate.recommendation },
    sourceArtifacts: model.sourceArtifacts,
    reduced: model.reduced,
    producerVersion: model.producerVersion,
    generatedAt: model.generatedAt,
  }, null, 2)}\n`;
}

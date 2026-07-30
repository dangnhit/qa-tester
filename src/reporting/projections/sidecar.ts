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
 * finalized run is closed — so this sidecar is the only thing that lets a reader prove which gate, and
 * which source artifacts, a given XML or SARIF file came from. Without it the file would be a
 * self-certifying channel: a hand-edited XML would be indistinguishable from a real one.
 *
 * It takes the BYTES and hashes them here rather than accepting a caller-computed digest, and that is
 * the whole point of the parameter: a sidecar that could be handed a checksum would be able to describe
 * bytes it never saw, which is precisely the claim it exists to make impossible.
 *
 * `reduced` is the ONLY field naming the protected-environment condition. The spec's sample sidecar
 * listed `protectedEnvironment` beside it; that is one bit under two names, and two names for one bit
 * is a drift surface — the pair can only ever disagree by being wrong. `reduced` is the one that says
 * what the file actually is.
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

export const evidenceModes = ["forbidden", "off", "optional", "on-failure", "always", "required"] as const;
export type EvidenceMode = (typeof evidenceModes)[number];
export type EvidenceChannel = "logs" | "console" | "network" | "screenshot" | "trace" | "video";
export type EvidencePolicyLayer = Partial<Record<EvidenceChannel, EvidenceMode>>;
export type EvidencePolicyLayers = { safety?: EvidencePolicyLayer; profile?: EvidencePolicyLayer; run?: EvidencePolicyLayer; testcase?: EvidencePolicyLayer };
export type ResolvedEvidencePolicy = Readonly<Record<EvidenceChannel, EvidenceMode>>;

const defaults: ResolvedEvidencePolicy = {
  logs: "always",
  console: "always",
  network: "always",
  screenshot: "on-failure",
  trace: "on-failure",
  video: "off",
};
const rank: Record<Exclude<EvidenceMode, "forbidden">, number> = { off: 0, optional: 1, "on-failure": 2, always: 3, required: 4 };

function resolveChannel(channel: EvidenceChannel, layers: EvidencePolicyLayers): EvidenceMode {
  const safety = layers.safety?.[channel];
  if (safety !== undefined) return safety;
  const configured = [layers.profile?.[channel], layers.run?.[channel], layers.testcase?.[channel]].filter((value): value is EvidenceMode => value !== undefined);
  if (configured.includes("forbidden")) return "forbidden";
  const values = [defaults[channel], ...configured] as Exclude<EvidenceMode, "forbidden">[];
  return values.reduce((strongest, candidate) => rank[candidate] > rank[strongest] ? candidate : strongest);
}

/** Resolves layered evidence policy without allowing a lower layer to weaken an existing requirement. */
export function resolveEvidencePolicy(layers: EvidencePolicyLayers): ResolvedEvidencePolicy {
  return Object.fromEntries((Object.keys(defaults) as EvidenceChannel[]).map((channel) => [channel, resolveChannel(channel, layers)])) as ResolvedEvidencePolicy;
}

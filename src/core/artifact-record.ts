import type { ArtifactType } from "../contracts/types.js";

export type ArtifactRecord = {
  id: string;
  type: ArtifactType;
  relativePath: string;
  sha256: string;
  mediaType?: string;
  captureType?: "screenshot" | "trace" | "console" | "network" | "log";
  dimensions?: { width: number; height: number };
  provenance: string;
  relationships: string[];
};

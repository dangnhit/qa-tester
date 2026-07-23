import { parseAllDocuments } from "yaml";

import { AuthoringParseError } from "../core/errors.js";

function assertObjectRoot(value: unknown): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new AuthoringParseError("Authoring documents must have an object root.");
  }

  return value as Record<string, unknown>;
}

export function parseAuthoringDocument(source: string, format: "json" | "yaml"): unknown {
  if (format === "json") {
    try {
      return assertObjectRoot(JSON.parse(source));
    } catch (error) {
      if (error instanceof AuthoringParseError) {
        throw error;
      }
      throw new AuthoringParseError(`Invalid JSON authoring document: ${(error as Error).message}`);
    }
  }

  const documents = parseAllDocuments(source);
  if (documents.length !== 1) {
    throw new AuthoringParseError("YAML multi-document input is not supported.");
  }

  const [document] = documents;
  if (document === undefined) {
    throw new AuthoringParseError("YAML authoring document is empty.");
  }
  if (document.errors.length > 0) {
    throw new AuthoringParseError(`Invalid YAML authoring document: ${document.errors[0]?.message ?? "unknown error"}`);
  }

  return assertObjectRoot(document.toJSON());
}

/* This file is generated from shared/schemas. Do not edit manually. */

export type Strings = string[];

export interface CanonicalChangeScope {
  artifactType: "change-scope";
  schemaVersion: "1.0.0";
  producerVersion: string;
  changeScopeId: string;
  runId: string;
  /**
   * @minItems 1
   */
  changes: [
    {
      id: string;
      requirementIds: Strings;
      codeSurfaces: Strings;
      declaredDependencies: Strings;
      gitPaths: Strings;
      userScope: Strings;
    },
    ...{
      id: string;
      requirementIds: Strings;
      codeSurfaces: Strings;
      declaredDependencies: Strings;
      gitPaths: Strings;
      userScope: Strings;
    }[]
  ];
  inputChecksum: string;
  provenance: {
    kind: "git-diff" | "user-change" | "declared-change";
    reference: string;
  };
}

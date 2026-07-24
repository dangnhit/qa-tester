/* This file is generated from shared/schemas. Do not edit manually. */

export type Hook =
  | {
      id: Id;
      kind: "command";
      command: string;
      args: string[];
    }
  | {
      id: Id;
      kind: "api";
      fixture: string;
    }
  | {
      id: Id;
      kind: "module";
      modulePath: RelativeModulePath;
      exportName?: string;
    };
export type Id = string;
export type RelativeModulePath = string;

export interface QASkillsDeclarativeConfiguration {
  version: 1;
  headers?: {
    /**
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^[A-Za-z][A-Za-z0-9-]*$".
     */
    [k: string]: string;
  };
  hooks?: Hook[];
}

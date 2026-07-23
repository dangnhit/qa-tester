/* This file is generated from shared/schemas. Do not edit manually. */

export type Action =
  | {
      kind: "open";
      url: Value;
    }
  | {
      kind: "click";
      locator: Locator;
    }
  | {
      kind: "fill";
      locator: Locator;
      value: Value;
    }
  | {
      kind: "select";
      locator: Locator;
      value: Value;
    }
  | {
      kind: "check";
      locator: Locator;
    }
  | {
      kind: "uncheck";
      locator: Locator;
    }
  | {
      kind: "press";
      locator: Locator;
      key: string;
    }
  | {
      kind: "upload";
      locator: Locator;
      /**
       * @minItems 1
       */
      files: [string, ...string[]];
    }
  | {
      kind: "wait";
      milliseconds?: number;
      locator?: Locator;
    };
export type Value =
  | string
  | {
      secretRef: string;
    };
export type Assertion =
  | {
      kind: "visible";
      locator: Locator;
    }
  | {
      kind: "text";
      locator: Locator;
      text: string;
    }
  | {
      kind: "value";
      locator: Locator;
      value: Value;
    }
  | {
      kind: "url";
      url: string;
    }
  | {
      kind: "count";
      locator: Locator;
      count: number;
    }
  | {
      kind: "enabled" | "disabled" | "checked";
      locator: Locator;
    }
  | {
      kind: "response-status";
      url: string;
      status: number;
    }
  | {
      kind: "console-policy";
      level?: "error" | "warning";
      allow?: string[];
    }
  | {
      kind: "network-policy";
      allow?: string[];
    };

export interface BrowserTestDSL {
  /**
   * @minItems 1
   */
  steps: [Step, ...Step[]];
}
export interface Step {
  id: string;
  action: Action;
  assertions?: Assertion[];
  sideEffect: "none" | "reversible" | "external" | "destructive";
  independent?: boolean;
}
export interface Locator {
  role?: string;
  name?: string;
  testId?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  css?: string;
}

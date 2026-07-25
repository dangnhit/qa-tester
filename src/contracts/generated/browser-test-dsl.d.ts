/* This file is generated from shared/schemas. Do not edit manually. */

export type Step = {
  [k: string]: unknown | undefined;
} & {
  id: string;
  action: Action;
  assertions?: Assertion[];
  sideEffect: "none" | "reversible" | "external" | "destructive";
  independent?: boolean;
} & {
  id: string;
  action: Action;
  assertions?: Assertion[];
  sideEffect: "none" | "reversible" | "external" | "destructive";
  independent?: boolean;
};
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
export type Locator =
  | {
      role: string;
      name?: string;
    }
  | {
      testId: string;
    }
  | {
      label: string;
    }
  | {
      placeholder: string;
    }
  | {
      text: string;
    }
  | {
      css: string;
    };
export type Assertion =
  | {
      kind: "visible";
      locator: Locator;
      expectedResultId?: string;
    }
  | {
      kind: "text";
      locator: Locator;
      text: string;
      expectedResultId?: string;
    }
  | {
      kind: "value";
      locator: Locator;
      value: Value;
      expectedResultId?: string;
    }
  | {
      kind: "url";
      url: string;
      expectedResultId?: string;
    }
  | {
      kind: "count";
      locator: Locator;
      count: number;
      expectedResultId?: string;
    }
  | {
      kind: "enabled" | "disabled" | "checked";
      locator: Locator;
      expectedResultId?: string;
    }
  | {
      kind: "response-status";
      url: string;
      status: number;
      expectedResultId?: string;
    }
  | {
      kind: "console-policy";
      level?: "error" | "warning";
      allow?: string[];
      expectedResultId?: string;
    }
  | {
      kind: "network-policy";
      allow?: string[];
      expectedResultId?: string;
    };

export interface BrowserTestDSL {
  /**
   * @minItems 1
   */
  steps: [Step, ...Step[]];
}

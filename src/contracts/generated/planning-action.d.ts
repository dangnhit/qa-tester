/* This file is generated from shared/schemas. Do not edit manually. */

export type BoundedPlanningAction =
  | {
      kind: "navigate";
      url: string;
    }
  | {
      kind: "click";
      locator: Locator;
    }
  | {
      kind: "fill";
      locator: Locator;
      value: string;
    }
  | {
      kind: "assert-text";
      locator: Locator;
      text: string;
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
    };

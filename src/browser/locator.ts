import type { Page } from "@playwright/test";

import type { LocatorDefinition, ResolvedLocator } from "./types.js";

const allowedKeys = new Set(["role", "name", "testId", "label", "placeholder", "text", "css"]);
const priority = ["role", "testId", "label", "placeholder", "text", "css"] as const;

export type LocatorKind = (typeof priority)[number];

export function locatorKind(definition: LocatorDefinition): LocatorKind {
  for (const key of Object.keys(definition)) {
    if (!allowedKeys.has(key)) throw new Error(`Unsupported locator field: ${key}`);
  }
  for (const kind of priority) if (definition[kind] !== undefined) return kind;
  throw new Error("A locator requires a supported selector");
}

export function resolveLocator(page: Page, definition: LocatorDefinition): ResolvedLocator {
  const kind = locatorKind(definition);
  if (kind === "role") {
    const role = definition.role;
    if (role === undefined) throw new Error("Role locator requires role");
    const ariaRole = role as Parameters<Page["getByRole"]>[0];
    return definition.name === undefined ? page.getByRole(ariaRole) : page.getByRole(ariaRole, { name: definition.name });
  }
  if (kind === "testId") return page.getByTestId(definition.testId as string);
  if (kind === "label") return page.getByLabel(definition.label as string);
  if (kind === "placeholder") return page.getByPlaceholder(definition.placeholder as string);
  if (kind === "text") return page.getByText(definition.text as string);
  const css = definition.css as string;
  if (/^\s*(?:xpath=|\/\/)/i.test(css)) throw new Error("XPath selectors are not supported");
  return page.locator(css);
}

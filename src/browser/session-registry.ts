import type { ActiveBrowserSession } from "./types.js";

export const activeBrowserSessions = new Map<string, ActiveBrowserSession>();

export function getActiveBrowserSession(attemptId: string): ActiveBrowserSession | undefined {
  return activeBrowserSessions.get(attemptId);
}

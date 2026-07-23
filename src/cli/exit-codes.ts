export const ExitCode = {
  SUCCESS: 0,
  UNMET_OBLIGATIONS: 1,
  BLOCKED: 2,
  INVALID_INPUT: 3,
  SAFETY_DENIED: 4,
  ABORTED_OR_INTERNAL: 5,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

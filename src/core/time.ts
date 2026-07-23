export function utcNow(clock: () => Date = () => new Date()): string {
  return clock().toISOString();
}

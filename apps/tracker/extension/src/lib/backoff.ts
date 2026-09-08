export const MAX_BACKOFF_MS = 5 * 60_000;

export function backoffMs(failedAttempts: number): number {
  return Math.min(1000 * 2 ** failedAttempts, MAX_BACKOFF_MS);
}

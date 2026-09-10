export type Result<T> = { ok: true; value: T } | { ok: false; error: string; status?: number };

// Only a request that will never succeed as written may drop its outbox row.
// 408 and 429 are fixed by retrying; 401 and 403 by signing in, and 403 is
// what a proxy in front of tracker returns for a lapsed session, so deleting
// on it would throw away data a login would have delivered.
const RETRYABLE = new Set([401, 403, 408, 429]);

export function isPermanentFailure(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && !RETRYABLE.has(status);
}

/**
 * Tiny in-process fixed-window rate limiter. The server is a single Bun
 * process, so an in-memory map is enough to blunt floods and abuse of the
 * authenticated-but-expensive endpoints (remote image imports, MCP traffic,
 * uploads). If the server is ever scaled horizontally, swap the backing store
 * for a shared one (e.g. Redis) — the call sites stay the same.
 */

type Bucket = { count: number; resetAt: number };

export type RateDecision = {
  /** Whether the request fits within the current window. */
  readonly ok: boolean;
  /** Milliseconds until the window resets (0 when allowed). */
  readonly retryAfterMs: number;
};

export type RateLimiter = {
  /** Consume `cost` units (default 1) for `key` in the current window. */
  check: (key: string, cost?: number) => RateDecision;
};

export function createRateLimiter({
  windowMs,
  max,
}: {
  windowMs: number;
  max: number;
}): RateLimiter {
  const buckets = new Map<string, Bucket>();
  let lastSweep = 0;

  /** Drop expired buckets at most once per window so the map can't grow
   * unbounded across many distinct keys. */
  const sweep = (now: number) => {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  };

  return {
    check(key, cost = 1) {
      const now = Date.now();
      sweep(now);
      const existing = buckets.get(key);
      if (!existing || existing.resetAt <= now) {
        if (cost > max) return { ok: false, retryAfterMs: windowMs };
        buckets.set(key, { count: cost, resetAt: now + windowMs });
        return { ok: true, retryAfterMs: 0 };
      }
      if (existing.count + cost > max) {
        return { ok: false, retryAfterMs: existing.resetAt - now };
      }
      existing.count += cost;
      return { ok: true, retryAfterMs: 0 };
    },
  };
}

/** Remote-image imports fetch arbitrary upstream URLs through the server, so
 * they're the priciest authenticated action. Budget is counted in images
 * (each import call costs `items.length`). */
export const importRateLimiter = createRateLimiter({
  windowMs: 10 * 60_000,
  max: 200,
});

/** MCP is an agent firehose — generous per-principal ceiling, just enough to
 * stop a runaway loop or a stolen token from hammering the endpoint. */
export const mcpRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 240,
});

/** Browser uploads are already bounded to 25 files / 25 MB per request; this
 * caps how often a session can fire those requests. */
export const uploadRateLimiter = createRateLimiter({
  windowMs: 5 * 60_000,
  max: 60,
});

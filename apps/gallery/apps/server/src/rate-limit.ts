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
  maxEntries = 100_000,
}: {
  windowMs: number;
  max: number;
  /** Hard ceiling on distinct keys held at once. A flood of unique keys (e.g.
   * spoofed client identifiers) would otherwise grow the map without bound
   * within a single window, since the periodic sweep only runs once per
   * window. New keys past this ceiling are rejected rather than stored. */
  maxEntries?: number;
}): RateLimiter {
  const buckets = new Map<string, Bucket>();
  let lastSweep = 0;

  /** Drop expired buckets. Throttled to once per window for the common path;
   * `force` bypasses the throttle when we're up against `maxEntries`. */
  const sweep = (now: number, force = false) => {
    if (!force && now - lastSweep < windowMs) return;
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
        if (!existing && buckets.size >= maxEntries) {
          sweep(now, true);
          if (buckets.size >= maxEntries) {
            return { ok: false, retryAfterMs: windowMs };
          }
        }
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

/** The visit-stats beacon is anonymous and fire-and-forget. Keyed by client IP
 * and counted in events (each beacon costs `events.length`), this bounds how
 * many counters one address can drive per minute — generous, since a single
 * walkthrough legitimately emits a page view, a session enter, a tour
 * completion and one event per inspected artwork. */
export const statsBeaconRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 600,
});

/** The public museum image route is anonymous, and a cache miss triggers an
 * upstream fetch + disk write — so a shared museum URL could be turned into a
 * traffic amplifier. Keyed by client IP and consulted only on the cache-miss
 * path, this bounds how many *new* upstream fetches one address can drive;
 * cache hits stay free. Generous, since one cold room legitimately misses
 * many distinct images at once. */
export const publicImageRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 120,
});

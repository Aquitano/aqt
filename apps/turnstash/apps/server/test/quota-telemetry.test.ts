import { expect, setDefaultTimeout, test } from "bun:test";

import { eq, sql } from "drizzle-orm";
import { Clock, Effect, Exit, Metric } from "effect";

import { Db } from "../src/db/client.ts";
import { limitSamples } from "../src/db/schema.ts";
import { makeQuotaSampler, quotaMetrics } from "../src/quota-telemetry.ts";
import { runTest } from "./support.ts";

setDefaultTimeout(30_000);
const hour = 3_600_000;

test("quota gauges sample active limits without a dashboard and clear stale or removed windows", async () => {
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      const now = yield* Clock.currentTimeMillis;
      yield* db.insert(limitSamples).values([
        {
          provider: "claude",
          windowMinutes: 300,
          observedAt: new Date(now - hour),
          resetsAt: new Date(now + 2 * hour),
          usedPercent: 60,
        },
        {
          provider: "claude",
          windowMinutes: 300,
          observedAt: new Date(now),
          resetsAt: new Date(now + 2 * hour),
          usedPercent: 90,
        },
        {
          provider: "codex",
          windowMinutes: 10_080,
          observedAt: new Date(now - hour),
          resetsAt: new Date(now + hour / 2),
          usedPercent: 60,
        },
        {
          provider: "codex",
          windowMinutes: 10_080,
          observedAt: new Date(now),
          resetsAt: new Date(now + hour / 2),
          usedPercent: 60,
        },
        {
          provider: "codex",
          windowMinutes: 300,
          observedAt: new Date(now - 20 * 60_000),
          resetsAt: new Date(now - 10 * 60_000),
          usedPercent: 100,
        },
      ]);
      const sample = yield* makeQuotaSampler;
      yield* sample();
      const claude = { provider: "claude", window_minutes: "300" };
      const codex = { provider: "codex", window_minutes: "10080" };
      expect((yield* Metric.value(Metric.withAttributes(quotaMetrics.low, claude))).value).toBe(1);
      expect(
        (yield* Metric.value(Metric.withAttributes(quotaMetrics.remaining, claude))).value,
      ).toBe(10);
      expect((yield* Metric.value(Metric.withAttributes(quotaMetrics.unused, codex))).value).toBe(
        1,
      );
      expect(
        (yield* Metric.value(Metric.withAttributes(quotaMetrics.projected, codex))).value,
      ).toBe(40);
      expect(
        (yield* Metric.value(Metric.withAttributes(quotaMetrics.sampled, claude))).value,
      ).toBeGreaterThanOrEqual(now / 1000);

      const sampledBeforeFailure = yield* Metric.value(
        Metric.withAttributes(quotaMetrics.sampled, claude),
      );
      const failure = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(sql`ALTER TABLE limit_samples RENAME TO unavailable_limit_samples`);
            yield* sample().pipe(Effect.provideService(Db, tx));
          }),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(failure)).toBe(true);
      expect((yield* Metric.value(Metric.withAttributes(quotaMetrics.sampled, claude))).value).toBe(
        sampledBeforeFailure.value,
      );

      yield* db.delete(limitSamples).where(eq(limitSamples.provider, "claude"));
      yield* db
        .update(limitSamples)
        .set({ observedAt: new Date(now - 31 * 60_000) })
        .where(eq(limitSamples.observedAt, new Date(now)));
      yield* sample();
      expect((yield* Metric.value(Metric.withAttributes(quotaMetrics.low, claude))).value).toBe(0);
      expect((yield* Metric.value(Metric.withAttributes(quotaMetrics.fresh, claude))).value).toBe(
        0,
      );
      expect(
        (yield* Metric.value(Metric.withAttributes(quotaMetrics.observed, claude))).value,
      ).toBe(0);
      expect((yield* Metric.value(Metric.withAttributes(quotaMetrics.unused, codex))).value).toBe(
        0,
      );
      expect((yield* Metric.value(Metric.withAttributes(quotaMetrics.fresh, codex))).value).toBe(0);

      yield* db.delete(limitSamples);
      yield* sample();
      expect(
        (yield* Metric.value(Metric.withAttributes(quotaMetrics.remaining, codex))).value,
      ).toBe(0);
      expect((yield* Metric.value(Metric.withAttributes(quotaMetrics.reset, codex))).value).toBe(0);
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
  );
});

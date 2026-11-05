import { expect, setDefaultTimeout, test } from "bun:test";

import { sql } from "drizzle-orm";
import { Clock, Effect } from "effect";

import { currentLimitsReport } from "../src/current-limits.ts";
import { Db } from "../src/db/client.ts";
import { limitSamples, machines } from "../src/db/schema.ts";
import { machineRoster } from "../src/stats.ts";
import { runTest } from "./support.ts";

setDefaultTimeout(30_000);
const minute = 60_000;

test("current quota reads omit history and preserve the burn anchor for a clock one minute behind", async () => {
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      const now = yield* Clock.currentTimeMillis;
      yield* db.insert(limitSamples).values([
        ...(
          [
            [-120, 60],
            [-90, 70],
            [-60.5, 77],
            [-45, 80],
            [0, 90],
          ] as const
        ).map(([offset, usedPercent]) => ({
          provider: "claude" as const,
          windowMinutes: 300,
          observedAt: new Date(now + offset * minute),
          resetsAt: new Date(now + 120 * minute),
          usedPercent,
        })),
        {
          provider: "claude",
          windowMinutes: 300,
          observedAt: new Date(now - 420 * minute),
          resetsAt: new Date(now + 60 * minute),
          usedPercent: 10,
        },
        {
          provider: "claude",
          windowMinutes: 300,
          observedAt: new Date(now - minute),
          resetsAt: new Date(now + 60 * minute),
          usedPercent: 100,
        },
        {
          provider: "codex",
          windowMinutes: 300,
          observedAt: new Date(now - 60 * minute),
          resetsAt: new Date(now - 30 * minute),
          usedPercent: 100,
        },
      ]);
      const report = yield* currentLimitsReport();
      expect(report.providers).toHaveLength(1);
      const window = report.providers[0]?.windows[0];
      expect(report.providers[0]?.windows).toHaveLength(1);
      expect(window?.outcome).toBe("open");
      expect(window?.usedPercent).toBe(90);
      expect(window?.firstUsedPercent).toBe(60);
      expect(window?.points.map((point) => point.usedPercent)).toEqual([70, 77, 80, 90]);
      const clientNow = Date.parse(report.generatedAt) - minute;
      expect(
        window?.points.findLast((point) => Date.parse(point.at) <= clientNow - 60 * minute)
          ?.usedPercent,
      ).toBe(70);
      expect(window).not.toHaveProperty("costUsd");
      expect(window).not.toHaveProperty("expiredValue");
    }),
  );
});

test("global quota and machine reads do not depend on request or valuation aggregates", async () => {
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      const alpha = crypto.randomUUID();
      const zeta = crypto.randomUUID();
      yield* db.insert(machines).values([
        { id: zeta, name: "Zeta", os: "linux", arch: "x64", tokenHash: zeta },
        { id: alpha, name: "Alpha", os: "linux", arch: "x64", tokenHash: alpha },
      ]);
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute(sql`ALTER TABLE model_requests RENAME TO unavailable_requests`);
          expect(
            (yield* currentLimitsReport().pipe(Effect.provideService(Db, tx))).providers,
          ).toEqual([]);
          expect(yield* machineRoster().pipe(Effect.provideService(Db, tx))).toEqual([
            { id: alpha, name: "Alpha" },
            { id: zeta, name: "Zeta" },
          ]);
          yield* tx.execute(sql`ALTER TABLE unavailable_requests RENAME TO model_requests`);
        }),
      );
    }),
  );
});

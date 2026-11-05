import { expect, setDefaultTimeout, test } from "bun:test";

import { MachineId, type ProviderId } from "@aqt/turnstash-core";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { cacheBreaks } from "../src/analysis.ts";
import { Db } from "../src/db/client.ts";
import {
  conversations,
  limitHits,
  limitSamples,
  modelRequests,
  subscriptionPlans,
  valuations,
} from "../src/db/schema.ts";
import { applyLimitBatch, limitDrain, limitsReport } from "../src/limits.ts";
import { monthlyProration } from "../src/stats.ts";
import { ensureBundledCatalog } from "../src/valuation.ts";
import { runTest } from "./support.ts";

setDefaultTimeout(30_000);

const machineId = MachineId.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const hour = 3_600_000;
const week = 10_080;
const dayStart = Date.now() - 20 * 24 * hour;
const after = (hours: number) => new Date(dayStart + hours * hour);

interface SeededRequest {
  readonly hours: number;
  readonly costUsd: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheWrite1hTokens?: number;
  readonly cacheWriteUsd?: number;
}

const seedConversation = Effect.fn("test.seedConversation")(function* (
  provider: ProviderId,
  conversationKey: string,
  requests: ReadonlyArray<SeededRequest>,
) {
  const db = yield* Db;
  const catalog = yield* ensureBundledCatalog();
  const [conversation] = yield* db
    .insert(conversations)
    .values({
      provider,
      conversationKey,
      title: conversationKey,
      projectPath: "/home/dev/project",
      projectKey: "project",
      startedAt: after(0),
      endedAt: after(100),
      messageCount: 0,
      requestCount: requests.length,
      parserVersion: 1,
    })
    .returning({ id: conversations.id });
  if (conversation === undefined) return yield* Effect.die("no conversation");
  if (requests.length === 0) return conversation.id;
  const rows = yield* db
    .insert(modelRequests)
    .values(
      requests.map((request, index) => ({
        conversationId: conversation.id,
        provider,
        requestKey: `${conversationKey}-${index}`,
        modelRaw: "claude-opus-5",
        modelId: "claude-opus-5",
        requestedAt: after(request.hours),
        inputTokens: 1,
        cacheReadTokens: request.cacheReadTokens ?? 0,
        cacheWriteTokens: request.cacheWriteTokens ?? 0,
        cacheWrite1hTokens: request.cacheWrite1hTokens ?? 0,
        outputTokens: 1,
        reasoningTokens: 0,
        usageBasis: "reported" as const,
      })),
    )
    .returning({ id: modelRequests.id });
  yield* db.insert(valuations).values(
    rows.map((row, index) => ({
      requestId: row.id,
      catalogVersion: catalog ?? "",
      costUsd: (requests[index]?.costUsd ?? 0).toFixed(10),
      breakdown: {
        inputUsd: 0,
        outputUsd: 0,
        cacheWriteUsd: requests[index]?.cacheWriteUsd ?? 0,
        cacheWrite1hUsd: 0,
        cacheReadUsd: 0,
        multiplier: 1,
      },
      active: true,
    })),
  );
  return conversation.id;
});

const reading = (hours: number, usedPercent: number, resetsAt: Date, plan?: string) => ({
  provider: "codex" as const,
  windowMinutes: week,
  observedAt: after(hours).toISOString(),
  usedPercent,
  resetsAt: resetsAt.toISOString(),
  ...(plan === undefined ? {} : { plan }),
});

test("the report prices each window and values only quota that expired at its reset", async () => {
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.insert(subscriptionPlans).values({
        provider: "codex",
        name: "ChatGPT Pro",
        monthlyPrice: "200",
        currency: "USD",
        startedOn: "2020-01-01",
      });
      yield* seedConversation("codex", "first", [
        { hours: 1, costUsd: 4 },
        { hours: 2, costUsd: 6 },
      ]);
      const earlyReset = after(24 * 7);
      const firstOfNext = after(24 + 24 * 7);
      yield* applyLimitBatch({
        machineId,
        readings: [
          reading(1, 10, earlyReset),
          reading(2, 30, earlyReset, "prolite"),
          reading(25, 1, firstOfNext),
        ],
      });
      const report = yield* limitsReport({});
      const codex = report.providers.find((provider) => provider.provider === "codex");
      expect(codex?.plan).toBe("pro lite");
      const windows = codex?.series[0]?.windows ?? [];
      const [replaced, reset] = windows;
      expect(replaced?.outcome).toBe("replaced");
      expect(replaced?.expiredValue).toEqual([]);
      expect(replaced?.costUsd).toBeCloseTo(10);
      expect(replaced?.costPerPercentUsd).toBeCloseTo(0.3);
      expect(reset?.outcome).toBe("reset");
      expect(reset?.usedPercent).toBe(1);
      const [expired] = reset?.expiredValue ?? [];
      expect(expired?.currency).toBe("USD");
      expect(expired?.amount).toBeGreaterThan(0);
    }),
  );
});

test("the same reading sent twice is stored once", async () => {
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      const resetsAt = after(24 * 7);
      const first = yield* applyLimitBatch({ machineId, readings: [reading(1, 10, resetsAt)] });
      const second = yield* applyLimitBatch({ machineId, readings: [reading(1, 10, resetsAt)] });
      expect(first.accepted).toBe(1);
      expect(second.accepted).toBe(0);
      expect(yield* db.select().from(limitSamples)).toHaveLength(1);
    }),
  );
});

test("hits collapse in the report and disappear with their conversation", async () => {
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      const conversationId = yield* seedConversation("claude", "limited", []);
      yield* db.insert(limitHits).values(
        [0, 0.1, 0.2].map((hours) => ({
          provider: "claude" as const,
          conversationId,
          occurredAt: after(hours),
          windowMinutes: 300,
          message: "You've hit your session limit",
        })),
      );
      const report = yield* limitsReport({});
      expect(report.providers[0]?.hits.map((hit) => hit.count)).toEqual([3]);
      yield* db.delete(conversations);
      expect((yield* limitsReport({})).providers).toEqual([]);
    }),
  );
});

test("drain attributes only the requests inside the selected span", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* seedConversation("codex", "inside", [
        { hours: 1, costUsd: 3 },
        { hours: 3, costUsd: 100 },
        { hours: 3 + 0.5 / 60, costUsd: 100 },
      ]);
      yield* seedConversation("codex", "also-inside", [{ hours: 2, costUsd: 1 }]);
      const drain = yield* limitDrain({
        provider: "codex",
        from: after(0).toISOString(),
        to: after(3).toISOString(),
      });
      expect(drain.costUsd).toBeCloseTo(4);
      expect(drain.requests).toBe(2);
      expect(drain.conversations.map((row) => row.title)).toEqual(["inside", "also-inside"]);
      expect(drain.projects.map((row) => row.projectKey)).toEqual(["project"]);
    }),
  );
});

test("a cache break is a request rewriting what the previous request had cached", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* seedConversation("claude", "broken", [
        { hours: 0, costUsd: 1, cacheWriteTokens: 100_000 },
        { hours: 0.05, costUsd: 1, cacheReadTokens: 100_000, cacheWriteTokens: 2_000 },
        { hours: 0.1, costUsd: 2, cacheWriteTokens: 102_000, cacheWriteUsd: 1.5 },
        { hours: 5, costUsd: 2, cacheWriteTokens: 102_000, cacheWriteUsd: 1.5 },
      ]);
      yield* seedConversation("claude", "first-request-only", [
        { hours: 0, costUsd: 1, cacheWriteTokens: 100_000 },
      ]);
      const report = yield* cacheBreaks({});
      expect(report.breaks).toBe(2);
      expect(report.withinLifetime).toBe(1);
      expect(report.rewriteCostUsd).toBeCloseTo(3);
      expect(report.rows.map((row) => row.withinLifetime)).toEqual([true, false]);
      expect(report.rows[1]?.idleMinutes).toBeCloseTo(294);
    }),
  );
});

test("cache expiry uses the preceding write tier and leaves ambiguous reads unknown", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* seedConversation("claude", "ttl-switch", [
        { hours: 0, costUsd: 1, cacheWriteTokens: 100_000 },
        { hours: 0.5, costUsd: 1, cacheWrite1hTokens: 100_000 },
        { hours: 0.6, costUsd: 1, cacheReadTokens: 90_000, cacheWrite1hTokens: 10_000 },
        { hours: 1, costUsd: 1, cacheWriteTokens: 100_000 },
        { hours: 1.01, costUsd: 1, cacheReadTokens: 100_000 },
        { hours: 1.5, costUsd: 1, cacheWriteTokens: 100_000 },
      ]);
      const report = yield* cacheBreaks({});
      expect(report.breaks).toBe(3);
      expect(report.unknownLifetime).toBe(1);
      expect(report.withinLifetime).toBe(1);
      expect(report.rows.map((row) => row.withinLifetime)).toEqual([false, true, null]);
    }),
  );
});

test("history reports retain current points and skip unrelated intervening windows", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* applyLimitBatch({
        machineId,
        readings: [
          reading(-24 * 300, 10, after(-24 * 294)),
          reading(-24 * 150, 20, after(-24 * 144)),
          reading(24 * 20 - 2, 10, after(24 * 21)),
          reading(24 * 20 - 1, 50, after(24 * 21)),
        ],
      });
      const report = yield* limitsReport({
        from: after(-24 * 300).toISOString(),
        to: after(-24 * 290).toISOString(),
      });
      const windows = report.providers[0]?.series[0]?.windows ?? [];
      expect(windows).toHaveLength(2);
      expect(windows[0]?.points).toHaveLength(1);
      expect(windows[1]?.points).toHaveLength(2);
      expect(windows[1]?.outcome).toBe("open");
    }),
  );
});

test("historical windows include readings before the requested start", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* applyLimitBatch({ machineId, readings: [reading(-24 * 150, 40, after(-24 * 144))] });
      const report = yield* limitsReport({
        from: after(-24 * 145).toISOString(),
        to: after(-24 * 140).toISOString(),
      });
      const window = report.providers[0]?.series[0]?.windows[0];
      expect(window?.outcome).toBe("reset");
      expect(window?.usedPercent).toBe(40);
      expect(window?.points).toHaveLength(1);
    }),
  );
});

test("expired values use overlapping windows and stay stable across historical query ranges", async () => {
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      const [plan] = yield* db
        .insert(subscriptionPlans)
        .values({
          provider: "codex",
          name: "Plan",
          monthlyPrice: "300",
          currency: "USD",
          startedOn: "2020-01-01",
        })
        .returning();
      if (plan === undefined) return yield* Effect.die("no plan");
      yield* applyLimitBatch({
        machineId,
        readings: [
          reading(-24 * 150, 40, after(-24 * 144)),
          { ...reading(-24 * 144 + 1, 50, after(-24 * 144 + 3)), windowMinutes: 300 },
          reading(1, 20, after(24 * 7)),
          { ...reading(11, 50, after(15)), windowMinutes: 300 },
          { ...reading(169, 50, after(172)), windowMinutes: 300 },
          { ...reading(201, 50, after(205)), windowMinutes: 300 },
        ],
      });
      const recent = yield* limitsReport({ from: after(170).toISOString() });
      const allTime = yield* limitsReport({ from: new Date(0).toISOString() });
      const shortOf = (report: typeof recent) =>
        report.providers[0]?.series.find((series) => series.windowMinutes === 300)?.windows ?? [];
      const short = shortOf(recent);
      for (const window of short)
        expect(
          shortOf(allTime).find((other) => other.resetsAt === window.resetsAt)?.expiredValue,
        ).toEqual(window.expiredValue);
      expect(short[0]?.expiredValue).toEqual([]);
      expect(short[1]?.expiredValue[0]?.amount).toBeCloseTo(
        monthlyProration(plan, { from: after(168), to: after(172) }) * 0.5,
      );
      expect(short[2]?.expiredValue[0]?.amount).toBeCloseTo(
        monthlyProration(plan, { from: after(200), to: after(205) }) * 0.5,
      );
      expect(short[2]?.expiredValue[0]?.amount).toBeGreaterThan(0);
      const historical = yield* limitsReport({
        from: after(-24 * 144 + 1).toISOString(),
        to: after(-24 * 144 + 4).toISOString(),
      });
      const historicalWindow = shortOf(historical)[0];
      expect(historicalWindow?.expiredValue).toEqual(shortOf(allTime)[0]?.expiredValue);
      expect(historicalWindow?.expiredValue[0]?.amount).toBeCloseTo(
        monthlyProration(plan, { from: after(-24 * 144), to: after(-24 * 144 + 3) }) * 0.5,
      );
    }),
  );
});

test("drain groups missing and literal unknown project keys into one destination", async () => {
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      const missing = yield* seedConversation("codex", "missing", [{ hours: 1, costUsd: 3 }]);
      const named = yield* seedConversation("codex", "named", [{ hours: 2, costUsd: 7 }]);
      yield* db
        .update(conversations)
        .set({ projectKey: null, projectPath: null })
        .where(eq(conversations.id, missing));
      yield* db
        .update(conversations)
        .set({ projectKey: "unknown", projectPath: "/home/dev/unknown" })
        .where(eq(conversations.id, named));
      const drain = yield* limitDrain({
        provider: "codex",
        from: after(0).toISOString(),
        to: after(3).toISOString(),
      });
      expect(drain.projects).toEqual([
        { projectKey: "unknown", projectPath: "/home/dev/unknown", requests: 2, costUsd: 10 },
      ]);
      expect(drain.requests).toBe(2);
      expect(drain.costUsd).toBe(10);
    }),
  );
});

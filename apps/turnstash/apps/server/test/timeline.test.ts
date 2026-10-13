import { expect, setDefaultTimeout, test } from "bun:test";

import { BadRequest, TimelineChanged } from "@aqt/turnstash-api";
import { and, eq } from "drizzle-orm";
import { Effect, Match, Result, Schema } from "effect";

import { Db } from "../src/db/client.ts";
import {
  conversations,
  messages,
  modelRequests,
  toolExecutions,
  valuations,
} from "../src/db/schema.ts";
import { getTimeline } from "../src/timeline.ts";
import { ensureBundledCatalog } from "../src/valuation.ts";
import { runTest } from "./support.ts";

setDefaultTimeout(30_000);
const at = (minute: number) => new Date(Date.UTC(2026, 8, 21, 9, minute));
const messageKey = "assistant/source?1";

const seed = Effect.gen(function* () {
  const db = yield* Db;
  const catalog = yield* ensureBundledCatalog();
  const [conversation] = yield* db
    .insert(conversations)
    .values({
      provider: "claude",
      conversationKey: "timeline",
      startedAt: at(0),
      endedAt: at(2),
      parserVersion: 1,
    })
    .returning({ id: conversations.id });
  if (conversation === undefined) return yield* Effect.die("conversation insert returned no row");
  const id = conversation.id;
  yield* db.insert(messages).values({
    conversationId: id,
    messageKey,
    seq: 0,
    role: "assistant",
    createdAt: at(0),
    parts: [],
    text: "source",
  });
  const requests = yield* db
    .insert(modelRequests)
    .values(
      [
        { key: "b", model: "beta", minute: 0, message: null },
        { key: "c", model: "beta", minute: 1, message: "missing" },
        { key: "a", model: "alpha", minute: 0, message: messageKey },
      ].map((request) => ({
        conversationId: id,
        provider: "claude" as const,
        requestKey: request.key,
        modelRaw: request.model,
        modelId: request.model,
        requestedAt: at(request.minute),
        messageKey: request.message,
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
        usageBasis: "reported" as const,
      })),
    )
    .returning({ id: modelRequests.id, key: modelRequests.requestKey });
  yield* db.insert(valuations).values(
    requests.map((request) => ({
      requestId: request.id,
      catalogVersion: catalog ?? "",
      active: true,
      costUsd: Match.value(request.key).pipe(
        Match.when("a", () => "1"),
        Match.when("c", () => "4"),
        Match.orElse(() => null),
      ),
      unpricedReason: request.key === "b" ? ("unknown_model" as const) : null,
    })),
  );
  yield* db.insert(toolExecutions).values([
    {
      conversationId: id,
      toolKey: "build",
      name: "Build",
      status: "error",
      startedAt: at(0),
      messageKey,
      input: { large: "not returned" },
      output: "not returned",
    },
    {
      conversationId: id,
      toolKey: "ended",
      name: "Read",
      status: "ok",
      endedAt: at(2),
      messageKey,
    },
    { conversationId: id, toolKey: "unknown", name: "Tool", status: "unknown", messageKey: null },
  ]);
  return id;
});

test("timeline orders equal timestamps by stable source keys and paginates without losing events", async () => {
  await runTest(
    Effect.gen(function* () {
      const id = yield* seed;
      const first = yield* getTimeline(id, undefined, 2);
      const second = yield* getTimeline(id, first.nextCursor ?? undefined, 2, first.version);
      const third = yield* getTimeline(id, second.nextCursor ?? undefined, 2, second.version);
      expect(
        [...first.items, ...second.items, ...third.items].map((event) => event.eventKey),
      ).toEqual([
        "request:a",
        "request:b",
        "tool:build",
        "request:c",
        "tool:ended",
        "tool:unknown",
      ]);
      expect(first.totalEvents).toBe(6);
      expect(third.nextCursor).toBeNull();
      expect(first.items.map((event) => event.previousModelId)).toEqual([null, "alpha"]);
      expect(second.items[1]?.previousModelId).toBeNull();
    }),
  );
});

test("timeline rejects a changed snapshot when an earlier priced request arrives", async () => {
  await runTest(
    Effect.gen(function* () {
      const id = yield* seed;
      const first = yield* getTimeline(id, undefined, 2);
      const db = yield* Db;
      const [request] = yield* db
        .insert(modelRequests)
        .values({
          conversationId: id,
          provider: "claude",
          requestKey: "late-arrival",
          modelRaw: "alpha",
          modelId: "alpha",
          requestedAt: at(-1),
          inputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
          outputTokens: 1,
          reasoningTokens: 0,
          usageBasis: "reported",
        })
        .returning({ id: modelRequests.id });
      if (request === undefined) return yield* Effect.die("request insert returned no row");
      const catalog = yield* ensureBundledCatalog();
      yield* db.insert(valuations).values({
        requestId: request.id,
        catalogVersion: catalog ?? "",
        active: true,
        costUsd: "10",
      });
      const changed = yield* getTimeline(id, first.nextCursor ?? undefined, 2, first.version).pipe(
        Effect.result,
      );
      expect(Result.isFailure(changed) && Schema.is(TimelineChanged)(changed.failure)).toBe(true);
      const reloaded = yield* getTimeline(id);
      expect(reloaded.version).not.toBe(first.version);
      expect(reloaded.pricedCostUsd).toBe(15);
      expect(reloaded.items[0]?.eventKey).toBe("request:late-arrival");
      expect(reloaded.items[1]?.cumulativeCostUsd).toBe(11);
      const missing = yield* getTimeline(id, "tool:deleted").pipe(Effect.result);
      expect(Result.isFailure(missing) && Schema.is(BadRequest)(missing.failure)).toBe(true);
    }),
  );
});

test("timeline rejects repriced pages until all loaded costs are refreshed together", async () => {
  await runTest(
    Effect.gen(function* () {
      const id = yield* seed;
      const first = yield* getTimeline(id, undefined, 2);
      const db = yield* Db;
      const [request] = yield* db
        .select({ id: modelRequests.id })
        .from(modelRequests)
        .where(and(eq(modelRequests.conversationId, id), eq(modelRequests.requestKey, "a")));
      if (request === undefined) return yield* Effect.die("request was not seeded");
      yield* db
        .update(valuations)
        .set({ costUsd: "0.5" })
        .where(and(eq(valuations.requestId, request.id), eq(valuations.active, true)));
      const changed = yield* getTimeline(id, first.nextCursor ?? undefined, 2, first.version).pipe(
        Effect.result,
      );
      expect(Result.isFailure(changed) && Schema.is(TimelineChanged)(changed.failure)).toBe(true);
      const refreshed = yield* getTimeline(id, undefined, 2);
      const next = yield* getTimeline(id, refreshed.nextCursor ?? undefined, 2, refreshed.version);
      expect(refreshed.items[0]?.cumulativeCostUsd).toBe(0.5);
      expect(next.items[1]?.costUsd).toBe(4);
      expect(next.items[1]?.cumulativeCostUsd).toBe(4.5);
      expect(next.version).toBe(refreshed.version);
    }),
  );
});

test("timeline accumulates priced requests once across pages and keeps unpriced requests visible", async () => {
  await runTest(
    Effect.gen(function* () {
      const id = yield* seed;
      const page = yield* getTimeline(id, "request:b", 4);
      expect(page.pricedCostUsd).toBe(5);
      expect(page.unpricedRequests).toBe(1);
      expect(
        page.items.map((event) => [event.cumulativeCostUsd, event.cumulativeUnpricedRequests]),
      ).toEqual([
        [1, 1],
        [5, 1],
        [5, 1],
        [5, 1],
      ]);
      const first = yield* getTimeline(id, undefined, 2);
      expect(first.items[1]?.costUsd).toBeNull();
      expect(first.items[1]?.unpricedReason).toBe("unknown_model");
    }),
  );
});

test("timeline returns only real transcript associations and preserves missing tool times and failures", async () => {
  await runTest(
    Effect.gen(function* () {
      const id = yield* seed;
      const page = yield* getTimeline(id);
      expect(page.items.map((event) => event.messageKey)).toEqual([
        messageKey,
        null,
        messageKey,
        null,
        messageKey,
        null,
      ]);
      expect(page.items[2]?.toolStatus).toBe("error");
      expect(page.items[4]?.timestamp).toBe(at(2).toISOString());
      expect(page.items[5]?.timestamp).toBeNull();
      expect(page.items[5]?.toolStatus).toBe("unknown");
      expect(page.items.some((event) => "input" in event || "output" in event)).toBe(false);
    }),
  );
});

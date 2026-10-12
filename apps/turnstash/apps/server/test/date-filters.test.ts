import { expect, setDefaultTimeout, test } from "bun:test";

import { Effect } from "effect";

import { Db } from "../src/db/client.ts";
import { conversations, modelRequests } from "../src/db/schema.ts";
import { dateWindow } from "../src/filters.ts";
import { computeStats, dailyStats } from "../src/stats.ts";
import { runTest } from "./support.ts";

setDefaultTimeout(30_000);

test("local midnight requests stay in the viewer's day across DST changes and legacy zone names", async () => {
  for (const filter of [
    {
      from: "2026-03-28T23:00:00.000Z",
      to: "2026-03-29T22:00:00.000Z",
      timeZone: "Europe/Berlin",
      day: "2026-03-29",
    },
    {
      from: "2026-11-01T04:00:00.000Z",
      to: "2026-11-02T05:00:00.000Z",
      timeZone: "America/New_York",
      day: "2026-11-01",
    },
    {
      from: "2026-09-30T18:30:00.000Z",
      to: "2026-10-01T18:30:00.000Z",
      timeZone: "Asia/Calcutta",
      day: "2026-10-01",
    },
  ]) {
    await runTest(
      Effect.gen(function* () {
        const db = yield* Db;
        const [conversation] = yield* db
          .insert(conversations)
          .values({
            provider: "claude",
            conversationKey: "local-midnight",
            startedAt: new Date(filter.from),
            endedAt: new Date(filter.to),
            parserVersion: 1,
          })
          .returning({ id: conversations.id });
        if (conversation === undefined) return yield* Effect.die("missing test conversation");
        yield* db.insert(modelRequests).values(
          [
            new Date(Date.parse(filter.from) - 1),
            new Date(filter.from),
            new Date(Date.parse(filter.to) - 1),
            new Date(filter.to),
          ].map((requestedAt, index) => ({
            conversationId: conversation.id,
            provider: "claude" as const,
            requestKey: `request-${index}`,
            modelRaw: "claude-sonnet-4-5",
            modelId: "claude-sonnet-4-5",
            requestedAt,
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cacheWrite1hTokens: 0,
            reasoningTokens: 0,
            usageBasis: "reported" as const,
          })),
        );
        const stats = yield* computeStats(filter);
        expect(stats.overall.requests).toBe(2);
        expect(stats.daily.map((row) => [row.date, row.requests])).toEqual([[filter.day, 2]]);
        expect((yield* dailyStats(filter)).daily).toEqual(stats.daily);
        expect((yield* computeStats({})).overall.requests).toBe(4);
      }),
    );
  }
  expect(dateWindow({ from: "2026-03-29", to: "2026-03-29" })).toEqual({
    from: new Date("2026-03-29T00:00:00Z"),
    to: new Date("2026-03-30T00:00:00Z"),
  });
});

import { expect, setDefaultTimeout, test } from "bun:test";

import { emptyUsage, type NormalizedConversation, sha256Hex } from "@aqt/turnstash-core";
import { pricingVersion } from "@aqt/turnstash-pricing";
import { count, eq, sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import { Db } from "../src/db/client.ts";
import {
  conversations,
  conversationTurns,
  machines,
  messages,
  modelRequests,
  pricingCatalogs,
  sourceRecords,
  sourceStreams,
  toolExecutions,
  valuations,
} from "../src/db/schema.ts";
import { normalizeConversation } from "../src/normalize.ts";
import { activeCatalog, upsertRule, valuePending } from "../src/valuation.ts";
import { runTest } from "./support.ts";

setDefaultTimeout(120_000);
const archiveSize = 32_770;
const timestamp = "2026-10-01T00:00:00.000Z";

test("normalization retains large key sets and invalidates all changed valuations", async () => {
  let outputTokens = 1;
  const normalized = (): NormalizedConversation => ({
    conversationKey: "large",
    startedAt: timestamp,
    endedAt: timestamp,
    messages: Array.from({ length: archiveSize }, (_, seq) => ({
      messageKey: `message-${seq}`,
      seq,
      role: seq === 0 ? "user" : "assistant",
      createdAt: timestamp,
      parts: [],
      text: "",
    })),
    toolExecutions: Array.from({ length: archiveSize }, (_, index) => ({
      toolKey: `tool-${index}`,
      messageKey: `message-${index}`,
      name: "Read",
      input: null,
      output: null,
      status: "ok",
    })),
    requests: Array.from({ length: archiveSize }, (_, index) => ({
      requestKey: `request-${index}`,
      messageKey: `message-${index}`,
      modelRaw: "gpt-5.5",
      requestedAt: timestamp,
      usage: { ...emptyUsage, outputTokens },
      usageBasis: "reported",
    })),
  });
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      const machineId = crypto.randomUUID();
      yield* db.insert(machines).values({
        id: machineId,
        name: "large-test",
        os: "linux",
        arch: "x64",
        tokenHash: sha256Hex(machineId),
      });
      const [stream] = yield* db
        .insert(sourceStreams)
        .values({
          machineId,
          provider: "claude",
          streamId: "test/json/session.json",
        })
        .returning({ id: sourceStreams.id });
      if (stream === undefined) return yield* Effect.die("missing test stream");
      yield* db.insert(sourceRecords).values({
        streamRef: stream.id,
        provider: "claude",
        recordKey: "0",
        contentHash: sha256Hex("{}"),
        payload: "{}",
        observedAt: new Date(timestamp),
        conversationKey: "large",
      });
      const id = yield* normalizeConversation("claude", "large");
      expect(id).not.toBeNull();
      const catalog = yield* activeCatalog();
      yield* db.execute(sql`
      INSERT INTO ${valuations} (request_id, catalog_version, cost_usd, active, pricing_version)
      SELECT id, ${catalog.version}, 1, true, ${pricingVersion} FROM ${modelRequests}
    `);
      outputTokens = 2;
      yield* normalizeConversation("claude", "large");
      for (const table of [messages, toolExecutions, modelRequests]) {
        const [row] = yield* db.select({ n: count() }).from(table);
        expect(row?.n).toBe(archiveSize);
      }
      expect(yield* db.select().from(valuations)).toEqual([]);
    }),
    {
      claude: {
        id: "claude",
        parserVersion: 1,
        conversationKeyOf: () => Option.some("large"),
        normalize: normalized,
      },
    },
  );
});

test("a catalog can activate and regroup more than 32767 conversations", async () => {
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      const live = yield* activeCatalog();
      yield* db.execute(sql`
      INSERT INTO ${conversations} (provider, conversation_key, started_at, ended_at, parser_version)
      SELECT 'claude', 'session-' || n, ${timestamp}::timestamptz, ${timestamp}::timestamptz, 1
      FROM generate_series(1, ${archiveSize}) AS n
    `);
      yield* db.execute(sql`
      INSERT INTO ${modelRequests} (conversation_id, provider, request_key, model_raw, model_id,
        requested_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cache_write_1h_tokens, reasoning_tokens, usage_basis, turn_index)
      SELECT id, 'claude', 'request', 'proxy-model', 'proxy-model', started_at, 1, 1, 0, 0, 0, 0, 'reported', 0
      FROM ${conversations}
    `);
      yield* db.execute(sql`
      INSERT INTO conversation_turns (conversation_id, turn_index, first_seq, started_at, user_excerpt,
        category, primary_model_id, tools, skills, mcp_servers, commands, edits, retries, analysis_version)
      SELECT id, 0, 0, started_at, '', 'other', 'proxy-model', '{}', '{}', '{}', '{}', 0, 0, 1 FROM ${conversations}
    `);
      yield* db.execute(sql`
      INSERT INTO ${valuations} (request_id, catalog_version, cost_usd, active, pricing_version)
      SELECT id, ${live.version}, 1, true, ${pricingVersion} FROM ${modelRequests}
    `);
      yield* upsertRule("proxy-model", { kind: "alias", target: "gpt-5.5" });
      const [pending] = yield* db
        .select({ version: pricingCatalogs.version })
        .from(pricingCatalogs)
        .where(eq(pricingCatalogs.pending, true));
      if (pending === undefined) return yield* Effect.die("missing pending catalog");
      yield* db.execute(sql`
      INSERT INTO ${valuations} (request_id, catalog_version, cost_usd, active, pricing_version)
      SELECT id, ${pending.version}, 1, false, ${pricingVersion} FROM ${modelRequests}
    `);
      // Bulk fixtures bypass the normal autovacuum interval. Refresh estimates before the worker's queries.
      for (const table of [conversations, modelRequests, conversationTurns, valuations])
        yield* db.execute(sql`ANALYZE ${table}`);
      yield* valuePending(1);
      expect((yield* activeCatalog()).version).toBe(pending.version);
      const [grouped] = yield* db.execute<{ n: number }>(
        sql`
      SELECT count(*)::int AS n FROM conversation_turns WHERE primary_model_id = 'gpt-5.5'
    `,
        "objects",
      );
      expect(grouped?.n).toBe(archiveSize);
    }),
  );
});

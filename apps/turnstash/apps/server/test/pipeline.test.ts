import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";

import { Api, Unauthorized } from "@aqt/turnstash-api";
import {
  MachineId,
  RecordKey,
  sha256Hex,
  StreamId,
  type WireRecord,
  type Normalizer,
} from "@aqt/turnstash-core";
import { catalogVersion, bundledEntries, pricingVersion } from "@aqt/turnstash-pricing";
import { claudeNormalizer } from "@aqt/turnstash-providers";
import { BunHttpClient, BunHttpServer } from "@effect/platform-bun";
import { and, count, eq, sql } from "drizzle-orm";
import { type Context, Effect, Layer, Option, Redacted } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/http";
import { HttpApiClient } from "effect/http-api";

import { computeAnalysis } from "../src/analysis.ts";
import { AuthLive } from "../src/auth.ts";
import { ServerConfig } from "../src/config.ts";
import {
  conversationSummaries,
  deleteConversation,
  getConversation,
  getMessages,
  getRequest,
  listConversations,
} from "../src/conversations.ts";
import { Db } from "../src/db/client.ts";
import {
  conversationMachines,
  conversationTurns,
  conversations,
  dirtyConversations,
  machines,
  messages,
  modelRequests,
  pricingCatalogs,
  sourceRecords,
  tombstones,
  toolExecutions,
  valuations,
} from "../src/db/schema.ts";
import {
  applyCommitBatch,
  commitsForConversation,
  commitsForProject,
  relinkConversations,
  repositoryTasks,
} from "../src/git.ts";
import { ApiLive } from "../src/http.ts";
import { applyBatch, markDirty, tombstonesSince } from "../src/ingest.ts";
import { normalizeConversation, queueStale } from "../src/normalize.ts";
import { Normalizers } from "../src/registry.ts";
import { reprocessArchive } from "../src/reprocess.ts";
import { computeStats, projectDetail } from "../src/stats.ts";
import {
  activateCatalog,
  deleteRule,
  refreshPricing,
  upsertRule,
  valuePending,
} from "../src/valuation.ts";
import { workOnce } from "../src/worker.ts";
import { runTest, TestLayer } from "./support.ts";

setDefaultTimeout(30_000);

const fixture = new URL(
  "../../../packages/providers/test/fixtures/claude/config/projects/example-slug/11111111-1111-4111-8111-111111111111.jsonl",
  import.meta.url,
).pathname;
const streamId = StreamId.make("fixture/jsonl/projects/example-slug/session.jsonl");
const machineA = MachineId.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const machineB = MachineId.make("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

const fixtureRecords = (): Array<WireRecord> => {
  const text = readFileSync(fixture, "utf8");
  const records: Array<WireRecord> = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.trim() !== "") {
      records.push({
        provider: "claude",
        streamId,
        recordKey: RecordKey.make(String(offset)),
        contentHash: sha256Hex(line),
        payload: line,
        observedAt: "2026-09-21T10:00:00.000Z",
        redactions: 0,
      });
    }
    offset += Buffer.byteLength(line) + 1;
  }
  return records;
};

const batch = (batchId: string, machineId: MachineId, records: ReadonlyArray<WireRecord>) => ({
  batchId,
  machineId,
  agentVersion: "test",
  records,
});

const insertMachines = Effect.gen(function* () {
  const db = yield* Db;
  yield* db.insert(machines).values([
    { id: machineA, name: "a", os: "darwin", arch: "arm64", tokenHash: sha256Hex("token-a") },
    { id: machineB, name: "b", os: "linux", arch: "x64", tokenHash: sha256Hex("token-b") },
  ]);
});

const counts = Effect.gen(function* () {
  const db = yield* Db;
  const [c] = yield* db.select({ n: count() }).from(conversations);
  const [m] = yield* db.select({ n: count() }).from(messages);
  const [r] = yield* db.select({ n: count() }).from(modelRequests);
  const stats = yield* computeStats({});
  return {
    conversations: c?.n ?? 0,
    messages: m?.n ?? 0,
    requests: r?.n ?? 0,
    costUsd: stats.overall.costUsd,
  };
});

const repricedOpus = [1e-5, 5e-5, 1.25e-5, 1e-6, 2];

const insertRepricedCatalog = (opusRate: ReadonlyArray<number> = repricedOpus) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const entries = {
      primary: { ...bundledEntries.primary, "claude-opus-5": opusRate },
      fallback: bundledEntries.fallback,
    };
    const version = catalogVersion(entries);
    yield* db.insert(pricingCatalogs).values({ version, source: "test", entries, active: false });
    return version;
  });

test("conversation lists preserve pagination order and group machine links", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      const older = crypto.randomUUID();
      const newer = crypto.randomUUID();
      const newest = crypto.randomUUID();
      const ids = [older, newer, newest];
      yield* db.insert(conversations).values(
        ids.map((id, index) => ({
          id,
          provider: "claude" as const,
          conversationKey: id,
          startedAt: new Date(`2026-09-${21 + index}T10:00:00Z`),
          endedAt: new Date(`2026-09-${21 + index}T11:00:00Z`),
          parserVersion: 1,
        })),
      );
      yield* db.insert(conversationMachines).values([
        { conversationId: older, machineId: machineA },
        { conversationId: newest, machineId: machineB },
        { conversationId: older, machineId: machineB },
      ]);
      const summaries = yield* conversationSummaries([...ids, crypto.randomUUID()]);
      expect(summaries).toHaveLength(3);
      expect(summaries.find((row) => row.id === older)?.machineIds.toSorted()).toEqual(
        [machineA, machineB].toSorted(),
      );
      expect(summaries.find((row) => row.id === newer)?.machineIds).toEqual([]);
      expect(summaries.find((row) => row.id === newest)?.machineIds).toEqual([machineB]);
      const first = yield* listConversations({ limit: 2 });
      expect(first.items.map((row) => row.id)).toEqual([newest, newer]);
      if (first.nextCursor === null) throw new Error("missing conversation cursor");
      const second = yield* listConversations({ limit: 2, cursor: first.nextCursor });
      expect(second.items.map((row) => row.id)).toEqual([older]);
      expect(second.nextCursor).toBeNull();
    }),
  );
});

test("conversation search matches % and _ in the query literally", async () => {
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      const at = new Date("2026-09-21T10:00:00Z");
      yield* db.insert(conversations).values(
        ["50% off", "500 off", "snake_case", "snakeXcase"].map((title) => ({
          provider: "claude" as const,
          conversationKey: title,
          title,
          startedAt: at,
          endedAt: at,
          parserVersion: 1,
        })),
      );
      const titles = (q: string) =>
        listConversations({ q }).pipe(Effect.map((page) => page.items.map((row) => row.title)));
      expect(yield* titles("50%")).toEqual(["50% off"]);
      expect(yield* titles("e_c")).toEqual(["snake_case"]);
    }),
  );
});

test("message pages group multiple requests, and the conversation lists the requests no message holds", async () => {
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      const conversationId = crypto.randomUUID();
      const at = new Date("2026-09-21T10:00:00Z");
      yield* db.insert(conversations).values({
        id: conversationId,
        provider: "claude",
        conversationKey: conversationId,
        startedAt: at,
        endedAt: at,
        parserVersion: 1,
      });
      yield* db.insert(messages).values(
        ["first", "empty", "last"].map((messageKey, seq) => ({
          conversationId,
          messageKey,
          seq,
          role: "assistant" as const,
          createdAt: at,
          parts: [],
          text: "",
        })),
      );
      yield* db.insert(modelRequests).values(
        ["first", "last", "first", null, "missing"].map((messageKey, index) => ({
          conversationId,
          provider: "claude" as const,
          messageKey,
          requestKey: `request-${index}`,
          modelRaw: "claude-sonnet",
          modelId: "claude-sonnet",
          requestedAt: at,
          inputTokens: index + 1,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
          reasoningTokens: 0,
          usageBasis: "reported" as const,
        })),
      );
      const page = yield* getMessages(conversationId, undefined, 2);
      expect(page.items.map((row) => row.messageKey)).toEqual(["first", "empty"]);
      expect(page.items[0]?.requests.map((row) => row.requestKey).toSorted()).toEqual([
        "request-0",
        "request-2",
      ]);
      expect(page.items[0]?.requests.map((row) => row.inputTokens).toSorted()).toEqual([1, 3]);
      expect(page.items[1]?.requests).toEqual([]);
      expect(page.nextCursor).toBe("1");
      const next = yield* getMessages(conversationId, page.nextCursor ?? undefined, 2);
      expect(next.items.map((row) => row.messageKey)).toEqual(["last"]);
      expect(next.items[0]?.requests.map((row) => row.requestKey)).toEqual(["request-1"]);
      expect(next.nextCursor).toBeNull();
      const detail = yield* getConversation(conversationId);
      expect(detail.requestsWithoutMessage.map((row) => row.requestKey)).toEqual([
        "request-3",
        "request-4",
      ]);
      expect(detail.requestsWithoutMessageTotal).toBe(2);
    }),
  );
});

test("ingesting the same session twice, from two machines, or with a retried batch changes nothing", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const records = fixtureRecords();
      const first = yield* applyBatch(
        machineA,
        batch("11111111-0000-4000-8000-000000000001", machineA, records),
      );
      expect(first.accepted).toBe(records.length);
      yield* workOnce();
      const baseline = yield* counts;
      expect(baseline.conversations).toBe(1);
      expect(baseline.requests).toBeGreaterThan(0);
      expect(baseline.costUsd).toBeGreaterThan(0);

      const retried = yield* applyBatch(
        machineA,
        batch("11111111-0000-4000-8000-000000000001", machineA, records),
      );
      expect(retried).toEqual(first);
      const again = yield* applyBatch(
        machineA,
        batch("11111111-0000-4000-8000-000000000002", machineA, records),
      );
      expect(again).toMatchObject({ accepted: 0, duplicates: records.length, replaced: 0 });
      const other = yield* applyBatch(
        machineB,
        batch("11111111-0000-4000-8000-000000000003", machineB, records),
      );
      expect(other.accepted).toBe(records.length);
      yield* workOnce();
      expect(yield* counts).toEqual(baseline);
      const stats = yield* computeStats({});
      expect(stats.byMachine.map((machine) => machine.conversations)).toEqual([1, 1]);
    }),
  );
});

test("a conversation still receiving batches is normalized once it settles, not after every batch", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const config = yield* ServerConfig;
      yield* applyBatch(
        machineA,
        batch("11111111-0000-4000-8000-0000000000aa", machineA, fixtureRecords()),
      ).pipe(Effect.provideService(ServerConfig, { ...config, normalizeSettleMillis: 60_000 }));
      expect(yield* workOnce()).toMatchObject({ normalized: 0 });
      expect((yield* counts).conversations).toBe(0);
    }),
  );
});

test("tool output is stored on its execution and not repeated in the result part", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      yield* applyBatch(
        machineA,
        batch("11111111-0000-4000-8000-0000000000bb", machineA, fixtureRecords()),
      );
      yield* workOnce();
      const db = yield* Db;
      const executions = new Map(
        (yield* db.select().from(toolExecutions)).map((tool) => [tool.toolKey, tool.output]),
      );
      const results = (yield* db.select({ parts: messages.parts }).from(messages)).flatMap((row) =>
        row.parts.flatMap((part) => (part.type === "tool_result" ? [part] : [])),
      );
      const withExecution = results.filter(
        (part) => (executions.get(part.toolKey) ?? null) !== null,
      );
      expect(withExecution.length).toBeGreaterThan(0);
      expect(withExecution.map((part) => part.output)).toEqual(withExecution.map(() => null));
    }),
  );
});

test("a message page with a tool result carries its execution when the call is on another page", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      yield* applyBatch(
        machineA,
        batch("11111111-0000-4000-8000-0000000000bc", machineA, fixtureRecords()),
      );
      yield* workOnce();
      const db = yield* Db;
      const rows = yield* db
        .select({
          conversationId: messages.conversationId,
          seq: messages.seq,
          parts: messages.parts,
        })
        .from(messages);
      const [result] = rows.flatMap(({ conversationId, seq, parts }) =>
        parts.flatMap((part) =>
          part.type === "tool_result" ? [{ conversationId, seq, toolKey: part.toolKey }] : [],
        ),
      );
      if (result === undefined) throw new Error("the fixture holds no tool result");
      const page = yield* getMessages(result.conversationId, String(result.seq - 1), 1);
      const tool = page.toolExecutions.find((candidate) => candidate.toolKey === result.toolKey);
      expect(page.items.map((message) => message.seq)).toEqual([result.seq]);
      expect(tool?.messageKey).not.toBe(page.items[0]?.messageKey);
      expect(typeof tool?.output).toBe("string");
    }),
  );
});

test("NUL characters in a raw record or a conversation title are stored as replacement characters", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const records = fixtureRecords().map((record) => ({
        ...record,
        payload: record.payload.replace(
          '"aiTitle":"Summarize the entry point"',
          String.raw`"aiTitle":"Summarize\u0000 the entry point"`,
        ),
      }));
      const raw: WireRecord = {
        provider: "claude",
        streamId,
        recordKey: RecordKey.make("raw-nul"),
        contentHash: sha256Hex("raw-nul"),
        payload: "binary tool output \u0000 that is not JSON",
        observedAt: "2026-09-21T10:00:00.000Z",
        redactions: 0,
      };
      const result = yield* applyBatch(
        machineA,
        batch("11111111-0000-4000-8000-00000000000a", machineA, [...records, raw]),
      );
      expect(result.accepted).toBe(records.length + 1);
      const db = yield* Db;
      const [stored] = yield* db
        .select({ payload: sourceRecords.payload })
        .from(sourceRecords)
        .where(eq(sourceRecords.recordKey, raw.recordKey));
      expect(stored?.payload).toBe("binary tool output \ufffd that is not JSON");
      yield* workOnce();
      const [conversation] = yield* db.select({ title: conversations.title }).from(conversations);
      expect(conversation?.title).toBe("Summarize\ufffd the entry point");
    }),
  );
});

test("top conversations show their cost inside the period, and projectless ones open as unknown", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      yield* applyBatch(
        machineA,
        batch("11111111-0000-4000-8000-00000000000b", machineA, fixtureRecords()),
      );
      yield* workOnce();
      const db = yield* Db;
      const requests = yield* db
        .select({ requestedAt: modelRequests.requestedAt })
        .from(modelRequests)
        .orderBy(modelRequests.requestedAt);
      const from = requests.at(-1)?.requestedAt.toISOString();
      expect(requests.length).toBeGreaterThan(1);
      const lifetime = yield* computeStats({});
      const window = yield* computeStats(from === undefined ? {} : { from });
      expect(window.overall.costUsd).toBeLessThan(lifetime.overall.costUsd);
      expect(window.topConversations.map((row) => row.costUsd)).toEqual([window.overall.costUsd]);

      yield* db.update(conversations).set({ projectKey: null, projectPath: null });
      const unknown = yield* projectDetail("unknown", {});
      expect(unknown.stats.overall.costUsd).toBe(lifetime.overall.costUsd);
      expect(unknown.stats.topConversations).toHaveLength(1);
    }),
  );
});

test("a project without requests in the period still opens, with zero cost", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      yield* applyBatch(
        machineA,
        batch("13131313-0000-4000-8000-000000000001", machineA, fixtureRecords()),
      );
      yield* workOnce();
      const detail = yield* projectDetail("project", { from: "2020-01-01", to: "2020-01-31" });
      expect(detail.projectPath).toBe("/home/dev/project");
      expect(detail.stats.overall).toMatchObject({ requests: 0, costUsd: 0 });
    }),
  );
});

test("a changed record re-normalizes the conversation", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const records = fixtureRecords();
      yield* applyBatch(machineA, batch("22222222-0000-4000-8000-000000000001", machineA, records));
      yield* workOnce();
      const before = yield* counts;

      const index = records.findIndex((record) => record.payload.includes('"output_tokens":137'));
      const edited = records[index]!.payload.replace('"output_tokens":137', '"output_tokens":1137');
      const changed = { ...records[index]!, payload: edited, contentHash: sha256Hex(edited) };
      const result = yield* applyBatch(
        machineA,
        batch("22222222-0000-4000-8000-000000000002", machineA, [changed]),
      );
      expect(result).toMatchObject({ accepted: 0, duplicates: 0, replaced: 1 });
      yield* workOnce();
      const after = yield* counts;
      expect(after.requests).toBe(before.requests);
      expect(after.costUsd).toBeGreaterThan(before.costUsd);
    }),
  );
});

test("a new catalog keeps the valuations of models it does not reprice", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      yield* applyBatch(
        machineA,
        batch("34343434-0000-4000-8000-000000000001", machineA, fixtureRecords()),
      );
      yield* workOnce();
      const baseline = yield* counts;
      const version = yield* insertRepricedCatalog();
      yield* activateCatalog(version);
      expect(yield* counts).toEqual(baseline);
      const requests = yield* db.select({ modelRaw: modelRequests.modelRaw }).from(modelRequests);
      const opus = requests.filter((request) => request.modelRaw === "claude-opus-5").length;
      expect(opus).toBeGreaterThan(0);
      expect(requests.length).toBeGreaterThan(opus);
      expect((yield* workOnce()).valued).toBe(opus);
      expect((yield* counts).costUsd).toBeGreaterThan(baseline.costUsd);
      const [swapped] = yield* db
        .select({ n: count() })
        .from(valuations)
        .where(and(eq(valuations.catalogVersion, version), eq(valuations.active, true)));
      expect(swapped?.n).toBe(requests.length);
      const [total] = yield* db.select({ n: count() }).from(valuations);
      expect(total?.n).toBe(requests.length * 2);
    }),
  );
});

test("valuations written by an older pricing version are repriced and never carried over", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      yield* applyBatch(
        machineA,
        batch("35353535-0000-4000-8000-000000000001", machineA, fixtureRecords()),
      );
      yield* workOnce();
      const baseline = yield* counts;
      const outdated = { costUsd: "999", pricingVersion: pricingVersion - 1 };
      yield* db.update(valuations).set(outdated);
      expect((yield* workOnce()).valued).toBe(baseline.requests);
      expect(yield* counts).toEqual(baseline);

      yield* db.update(valuations).set(outdated);
      const version = yield* insertRepricedCatalog();
      yield* activateCatalog(version);
      yield* valuePending(1);
      const [carried] = yield* db
        .select({ n: count() })
        .from(valuations)
        .where(and(eq(valuations.catalogVersion, version), eq(valuations.costUsd, "999")));
      expect(carried?.n).toBe(0);
    }),
  );
});

test("revaluing an unchanged catalog recalculates its costs", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      yield* applyBatch(
        machineA,
        batch("88888888-0000-4000-8000-000000000001", machineA, fixtureRecords()),
      );
      yield* workOnce();
      const baseline = yield* counts;
      yield* db.update(valuations).set({ costUsd: "999" });
      yield* activateCatalog(catalogVersion(bundledEntries));
      expect((yield* counts).costUsd).toBe(999 * baseline.requests);
      expect((yield* workOnce()).valued).toBe(baseline.requests);
      expect(yield* counts).toEqual(baseline);
      expect((yield* workOnce()).valued).toBe(0);
    }),
  );
});

test("reprocessing queues retained records even when their earlier normalization produced nothing", async () => {
  let available = false;
  const normalizer: Normalizer = {
    ...claudeNormalizer,
    normalize: (key, records) => (available ? claudeNormalizer.normalize(key, records) : null),
  };
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      yield* applyBatch(
        machineA,
        batch("99999999-0000-4000-8000-000000000001", machineA, fixtureRecords()),
      );
      yield* workOnce();
      expect((yield* counts).conversations).toBe(0);
      expect(yield* db.select().from(dirtyConversations)).toHaveLength(0);
      available = true;
      expect((yield* reprocessArchive()).queued).toBe(1);
      yield* workOnce();
      const baseline = yield* counts;
      expect(baseline.conversations).toBe(1);
      expect(baseline.costUsd).toBeGreaterThan(0);
      yield* db.update(valuations).set({ costUsd: "999" });
      yield* reprocessArchive();
      yield* workOnce();
      expect(yield* counts).toEqual(baseline);
    }),
    { claude: normalizer },
  );
});

test("deleting a conversation purges it, writes a tombstone and blocks resurrection", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      const records = fixtureRecords();
      yield* applyBatch(machineA, batch("33333333-0000-4000-8000-000000000001", machineA, records));
      yield* workOnce();
      const [conversation] = yield* db.select({ id: conversations.id }).from(conversations);
      yield* deleteConversation(conversation!.id);
      expect(yield* counts).toMatchObject({ conversations: 0, messages: 0, requests: 0 });
      const tombstoned = yield* tombstonesSince(undefined);
      expect(tombstoned.map((row) => String(row.conversationKey))).toEqual([
        "11111111-1111-4111-8111-111111111111",
      ]);
      const keyless = records.filter((record) =>
        Option.isNone(claudeNormalizer.conversationKeyOf(streamId, record.payload)),
      ).length;
      const later = yield* applyBatch(
        machineB,
        batch("33333333-0000-4000-8000-000000000002", machineB, records),
      );
      expect(later).toMatchObject({ accepted: keyless, duplicates: records.length - keyless });
      yield* workOnce();
      yield* reprocessArchive();
      yield* workOnce();
      expect((yield* counts).conversations).toBe(0);
      const missing = yield* getMessages(conversation!.id, undefined, 10).pipe(Effect.flip);
      expect(missing._tag).toBe("NotFound");
    }),
  );
});

test("tombstone cursors replay their millisecond and include later-visible deletions", async () => {
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.execute(sql`
        INSERT INTO ${tombstones} (provider, conversation_key, deleted_at)
        VALUES ('claude', 'first', '2026-10-01T00:00:00.123456Z')
      `);
      const first = yield* tombstonesSince(undefined);
      expect(first.map((row) => row.deletedAt)).toEqual(["2026-10-01T00:00:00.123Z"]);
      expect(yield* tombstonesSince(first[0]?.deletedAt)).toEqual(first);
      yield* db.execute(sql`
        INSERT INTO ${tombstones} (provider, conversation_key, deleted_at)
        VALUES ('claude', 'second', '2026-10-01T00:00:00.123900Z'),
               ('claude', 'third', '2026-10-01T00:00:00.124000Z')
      `);
      expect(
        (yield* tombstonesSince(first[0]?.deletedAt))
          .map((row) => String(row.conversationKey))
          .sort(),
      ).toEqual(["first", "second", "third"]);
      expect(
        (yield* tombstonesSince("2026-10-01T00:00:00.124Z")).map((row) =>
          String(row.conversationKey),
        ),
      ).toEqual(["third"]);
    }),
  );
});

const commitBeforeTransaction = <A, E>(db: Db["Service"], first: Effect.Effect<A, E, Db>) =>
  new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return (...args: Parameters<typeof db.transaction>) =>
        Effect.andThen(first.pipe(Effect.provideService(Db, db)), target.transaction(...args));
    },
  });

test("deletion committed while normalization starts cannot restore the transcript", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      yield* applyBatch(machineA, batch(crypto.randomUUID(), machineA, fixtureRecords()));
      yield* workOnce();
      const [conversation] = yield* db.select().from(conversations);
      if (conversation === undefined) throw new Error("missing fixture conversation");

      const normalized = yield* normalizeConversation("claude", conversation.conversationKey).pipe(
        Effect.provideService(Db, commitBeforeTransaction(db, deleteConversation(conversation.id))),
      );

      expect(normalized).toBeNull();
      expect(yield* counts).toMatchObject({ conversations: 0, messages: 0, requests: 0 });
      expect(yield* tombstonesSince(undefined)).toHaveLength(1);
    }),
  );
});

test("deletion committed while ingestion starts blocks the in-flight records", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      const records = fixtureRecords();
      yield* applyBatch(machineA, batch(crypto.randomUUID(), machineA, records));
      yield* workOnce();
      const [conversation] = yield* db.select().from(conversations);
      if (conversation === undefined) throw new Error("missing fixture conversation");

      const result = yield* applyBatch(
        machineB,
        batch(crypto.randomUUID(), machineB, records),
      ).pipe(
        Effect.provideService(Db, commitBeforeTransaction(db, deleteConversation(conversation.id))),
      );

      const keyless = records.filter((record) =>
        Option.isNone(claudeNormalizer.conversationKeyOf(streamId, record.payload)),
      ).length;
      expect(result).toMatchObject({ accepted: keyless, duplicates: records.length - keyless });
      yield* workOnce();
      expect(yield* counts).toMatchObject({ conversations: 0, messages: 0, requests: 0 });
      expect(
        yield* db
          .select()
          .from(sourceRecords)
          .where(eq(sourceRecords.conversationKey, conversation.conversationKey)),
      ).toHaveLength(0);
    }),
  );
});

test("the HTTP api enrols a machine, accepts its batches and maps bad tokens, cursors and upstream documents to errors", async () => {
  const upstream = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("[]"))),
  );
  const web = HttpRouter.toWebHandler(
    ApiLive.pipe(
      Layer.provide(AuthLive),
      Layer.provide(BunHttpServer.layerHttpServices),
      Layer.provide(Layer.mergeAll(TestLayer(), Layer.succeed(HttpClient.HttpClient, upstream))),
    ),
  );
  // SAFETY: the client only ever calls fetch; Bun's extra preconnect static is never used.
  const fetchWith = (
    context: Context.Context<Db | Normalizers | HttpClient.HttpClient | ServerConfig>,
  ) =>
    ((input: string | URL | Request, init?: RequestInit) =>
      web.handler(
        input instanceof Request ? input : new Request(String(input), init),
        context,
      )) as typeof fetch;
  const clientFor = (token: string) =>
    HttpApiClient.make(Api, {
      baseUrl: "http://turnstash.test",
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(Redacted.make(token))),
    });
  try {
    await runTest(
      Effect.gen(function* () {
        const admin = yield* clientFor("admin-secret");
        const enrolled = yield* admin.admin.enroll({
          payload: { name: "laptop", os: "darwin", arch: "arm64", agentVersion: "test" },
        });
        const machine = yield* clientFor(enrolled.token);
        const records = fixtureRecords();
        const pushed = yield* machine.ingest.pushBatch({
          payload: batch("44444444-0000-4000-8000-000000000001", enrolled.machineId, records),
        });
        expect(pushed.accepted).toBe(records.length);
        const rejected = yield* (yield* clientFor("nope")).ingest
          .pushBatch({
            payload: batch("44444444-0000-4000-8000-000000000002", enrolled.machineId, records),
          })
          .pipe(Effect.flip);
        expect(rejected._tag).toBe("Unauthorized");
        const anonymous = yield* (yield* clientFor("")).read.stats({ query: {} }).pipe(Effect.flip);
        expect(anonymous).toBeInstanceOf(Unauthorized);
        expect(anonymous).toHaveProperty("reason", "missing");
        yield* workOnce();
        const stats = yield* admin.read.stats({ query: {} });
        expect(stats.overall.conversations).toBe(1);
        const context = yield* Effect.context<
          Db | Normalizers | HttpClient.HttpClient | ServerConfig
        >();
        const badCursor = yield* Effect.promise(() =>
          web.handler(
            new Request("http://turnstash.test/api/conversations?cursor=0%7Cjunk", {
              headers: { Authorization: "Bearer admin-secret" },
            }),
            context,
          ),
        );
        expect(badCursor.status).toBe(400);
        const refresh = yield* admin.admin.refreshPricing().pipe(Effect.flip);
        expect(refresh._tag).toBe("BadRequest");
      }).pipe(
        Effect.provide(
          Layer.effect(
            FetchHttpClient.Fetch,
            Effect.map(
              Effect.context<Db | Normalizers | HttpClient.HttpClient | ServerConfig>(),
              fetchWith,
            ),
          ),
        ),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(BunHttpClient.layer),
      ),
    );
  } finally {
    await web.dispose();
  }
});

test("successive versions of one record in a batch preserve the final payload and retry result", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      const original = fixtureRecords()[0];
      if (original === undefined) throw new Error("missing fixture record");
      const payload = original.payload + " ";
      const changed = { ...original, payload, contentHash: sha256Hex(payload) };
      const first = batch("55555555-0000-4000-8000-000000000001", machineA, [
        original,
        changed,
        changed,
      ]);
      const result = yield* applyBatch(machineA, first);
      expect(result).toMatchObject({ accepted: 1, replaced: 1, duplicates: 1 });
      expect(yield* applyBatch(machineA, first)).toEqual(result);
      expect((yield* db.select().from(sourceRecords)).map((row) => row.payload)).toEqual([payload]);
      const next = yield* applyBatch(
        machineA,
        batch("55555555-0000-4000-8000-000000000002", machineA, [original, changed]),
      );
      expect(next).toMatchObject({ accepted: 0, replaced: 2, duplicates: 0 });
      expect((yield* db.select().from(sourceRecords)).map((row) => row.payload)).toEqual([payload]);
    }),
  );
});

test("an older version of a record that arrives after a newer one is ignored", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      const original = fixtureRecords()[0];
      if (original === undefined) throw new Error("missing fixture record");
      const payload = original.payload + " ";
      const newer = {
        ...original,
        payload,
        contentHash: sha256Hex(payload),
        observedAt: "2026-09-21T11:00:00.000Z",
      };
      yield* applyBatch(machineA, batch("56565656-0000-4000-8000-000000000001", machineA, [newer]));
      const late = yield* applyBatch(
        machineA,
        batch("56565656-0000-4000-8000-000000000002", machineA, [original]),
      );
      expect(late).toMatchObject({ accepted: 0, replaced: 0, duplicates: 1 });
      expect((yield* db.select().from(sourceRecords)).map((row) => row.payload)).toEqual([payload]);
    }),
  );
});

test("a failed conversation backs off without blocking valuation, and new records retry it", async () => {
  for (const failure of ["query", "defect"] as const) {
    let attempts = 0;
    const poisonKey = "22222222-2222-4222-8222-222222222222";
    const normalizer: Normalizer = {
      ...claudeNormalizer,
      normalize: (key, records) => {
        const conversation = claudeNormalizer.normalize(key, records);
        if (key !== poisonKey || conversation === null) return conversation;
        attempts += 1;
        if (failure === "defect") throw new Error("broken parser");
        return {
          ...conversation,
          requests: conversation.requests.map((request) => ({
            ...request,
            usage: { ...request.usage, inputTokens: 3_000_000_000 },
          })),
        };
      },
    };
    await runTest(
      Effect.gen(function* () {
        yield* insertMachines;
        const db = yield* Db;
        const records = fixtureRecords();
        const poison = records.map((record) => {
          const payload = record.payload.replaceAll(
            "11111111-1111-4111-8111-111111111111",
            poisonKey,
          );
          return {
            ...record,
            streamId: StreamId.make("fixture/jsonl/poison.jsonl"),
            payload,
            contentHash: sha256Hex(payload),
          };
        });
        yield* applyBatch(
          machineA,
          batch("66666666-0000-4000-8000-000000000001", machineA, [...poison, ...records]),
        );
        const first = yield* workOnce().pipe(Effect.timeout("5 seconds"));
        expect(first.valued).toBeGreaterThan(0);
        expect(attempts).toBe(1);
        const [queued] = yield* db.select().from(dirtyConversations);
        expect(queued).toMatchObject({ conversationKey: poisonKey, attempts: 1 });
        expect(queued!.markedAt.getTime()).toBeGreaterThan(Date.now());
        yield* workOnce().pipe(Effect.timeout("5 seconds"));
        expect(attempts).toBe(1);
        const retried = poison[0]!.payload + " ";
        yield* applyBatch(
          machineA,
          batch("66666666-0000-4000-8000-000000000002", machineA, [
            { ...poison[0]!, payload: retried, contentHash: sha256Hex(retried) },
          ]),
        );
        yield* workOnce().pipe(Effect.timeout("5 seconds"));
        expect(attempts).toBe(2);
      }),
      { claude: normalizer },
    );
  }
});

test("re-normalizing an unchanged conversation rewrites none of its rows", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      yield* applyBatch(
        machineA,
        batch("efefefef-0000-4000-8000-000000000001", machineA, fixtureRecords()),
      );
      yield* workOnce();
      const versions = db.execute<{ versions: string }>(
        sql`select concat_ws('|',
          (select string_agg(xmin::text, ',' order by id) from messages),
          (select string_agg(xmin::text, ',' order by id) from tool_executions),
          (select string_agg(xmin::text, ',' order by id) from model_requests),
          (select string_agg(xmin::text, ',' order by conversation_id, turn_index) from conversation_turns)
        ) as versions`,
        "objects",
      );
      const before = yield* versions;
      yield* normalizeConversation("claude", "11111111-1111-4111-8111-111111111111");
      expect(yield* versions).toEqual(before);
    }),
  );
});

test("normalization applies corrections to request metadata even when billable tokens are unchanged", async () => {
  let correction: "none" | "reasoning" | "route" | "basis" | "source" = "none";
  const normalizer: Normalizer = {
    ...claudeNormalizer,
    normalize: (key, records) => {
      const conversation = claudeNormalizer.normalize(key, records);
      if (conversation === null) return null;
      return {
        ...conversation,
        requests: conversation.requests.map((request) => ({
          ...request,
          ...(correction === "reasoning"
            ? { usage: { ...request.usage, reasoningTokens: 7 } }
            : {}),
          ...(correction === "route" ? { routeHint: "openrouter" } : {}),
          ...(correction === "basis" ? { usageBasis: "estimated" as const } : {}),
          ...(correction === "source" ? { sourceRecordKey: "updated" } : {}),
        })),
      };
    },
  };
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      yield* applyBatch(
        machineA,
        batch("77777777-0000-4000-8000-000000000001", machineA, fixtureRecords()),
      );
      yield* workOnce();
      for (const next of ["reasoning", "route", "basis", "source"] as const) {
        correction = next;
        yield* normalizeConversation("claude", "11111111-1111-4111-8111-111111111111");
        const requests = yield* db.select().from(modelRequests);
        expect(requests.length).toBeGreaterThan(0);
        for (const request of requests) {
          if (next === "reasoning") expect(request.reasoningTokens).toBe(7);
          if (next === "route")
            expect(request).toMatchObject({ routeHint: "openrouter", route: "openrouter" });
          if (next === "basis") expect(request.usageBasis).toBe("estimated");
          if (next === "source") expect(request.sourceRecordKey).toBe("updated");
        }
        correction = "none";
        yield* normalizeConversation("claude", "11111111-1111-4111-8111-111111111111");
      }
      yield* db.update(modelRequests).set({ modelId: "outdated", route: "bedrock" });
      yield* markDirty([
        { provider: "claude", conversationKey: "11111111-1111-4111-8111-111111111111" },
      ]);
      yield* workOnce();
      const requests = yield* db.select().from(modelRequests);
      expect(
        requests.every((request) => request.modelId !== "outdated" && request.route === null),
      ).toBe(true);
    }),
    { claude: normalizer },
  );
});

test("a pricing rule reprices and regroups existing requests, and a refresh keeps it", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      yield* applyBatch(
        machineA,
        batch("99999999-0000-4000-8000-000000000001", machineA, fixtureRecords()),
      );
      yield* workOnce();
      const baseline = yield* counts;
      const [first] = yield* db
        .select({ modelRaw: modelRequests.modelRaw })
        .from(modelRequests)
        .limit(1);
      const modelRaw = first?.modelRaw ?? "";

      const rule = yield* upsertRule(modelRaw, {
        kind: "rate",
        inputPerMillion: 100,
        outputPerMillion: 100,
      });
      expect(rule.model).toBe(modelRaw.toLowerCase());
      const [ruled] = yield* db
        .select({ n: count() })
        .from(modelRequests)
        .where(eq(modelRequests.modelRaw, modelRaw));
      expect((yield* workOnce()).valued).toBe(ruled?.n ?? 0);
      const repriced = yield* counts;
      expect(repriced.costUsd).toBeGreaterThan(baseline.costUsd);

      const catalogsAfterRule = yield* db.select({ n: count() }).from(pricingCatalogs);
      yield* upsertRule(modelRaw, { kind: "rate", inputPerMillion: 100, outputPerMillion: 100 });
      expect(yield* db.select({ n: count() }).from(pricingCatalogs)).toEqual(catalogsAfterRule);

      yield* upsertRule(modelRaw, { kind: "alias", target: "grouped-elsewhere" });
      const chained = yield* upsertRule("another-proxy", { kind: "alias", target: modelRaw }).pipe(
        Effect.flip,
      );
      expect(chained._tag).toBe("BadRequest");
      yield* workOnce();
      const [regrouped] = yield* db
        .select({ n: count() })
        .from(modelRequests)
        .where(eq(modelRequests.modelId, "grouped-elsewhere"));
      expect(regrouped?.n).toBeGreaterThan(0);
      const [regroupedTurns] = yield* db
        .select({ n: count() })
        .from(conversationTurns)
        .where(eq(conversationTurns.primaryModelId, "grouped-elsewhere"));
      expect(regroupedTurns?.n).toBeGreaterThan(0);
      expect((yield* counts).costUsd).toBeLessThan(baseline.costUsd);

      yield* deleteRule(modelRaw);
      yield* workOnce();
      expect(yield* counts).toEqual(baseline);
      const [restored] = yield* db
        .select({ n: count() })
        .from(modelRequests)
        .where(eq(modelRequests.modelId, "grouped-elsewhere"));
      expect(restored?.n).toBe(0);
    }),
  );
});

test("the request inspector follows rate, alias and unpriced rules", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      yield* applyBatch(machineA, batch(crypto.randomUUID(), machineA, fixtureRecords()));
      yield* workOnce();
      const db = yield* Db;
      const [request] = yield* db.select().from(modelRequests).limit(1);
      if (request === undefined) return yield* Effect.die("expected a normalized request");

      yield* upsertRule(request.modelRaw, {
        kind: "rate",
        inputPerMillion: 7,
        outputPerMillion: 11,
      });
      yield* workOnce();
      expect((yield* getRequest(request.id)).priceEntry).toMatchObject({
        priceKey: `user:${request.modelRaw.toLowerCase()}`,
        inputPerToken: 7e-6,
        outputPerToken: 11e-6,
      });

      yield* upsertRule("inspector-target", {
        kind: "rate",
        inputPerMillion: 2,
        outputPerMillion: 3,
      });
      yield* upsertRule(request.modelRaw, { kind: "alias", target: "inspector-target" });
      yield* workOnce();
      expect((yield* getRequest(request.id)).priceEntry).toMatchObject({
        priceKey: "user:inspector-target",
        inputPerToken: 2e-6,
        outputPerToken: 3e-6,
      });

      yield* upsertRule(request.modelRaw, { kind: "unpriced", reason: "subscription" });
      yield* workOnce();
      expect((yield* getRequest(request.id)).priceEntry).toBeNull();
    }),
  );
});

test("a rule saved during a pending refresh keeps the refreshed rates, and regrouping waits for the swap", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      yield* applyBatch(
        machineA,
        batch("abababab-0000-4000-8000-000000000001", machineA, fixtureRecords()),
      );
      yield* workOnce();
      const baseline = yield* counts;
      yield* activateCatalog(yield* insertRepricedCatalog());

      const [first] = yield* db
        .select({ modelRaw: modelRequests.modelRaw, modelId: modelRequests.modelId })
        .from(modelRequests)
        .limit(1);
      yield* upsertRule(first?.modelRaw ?? "", { kind: "alias", target: "grouped-elsewhere" });
      const [pending] = yield* db
        .select({ entries: pricingCatalogs.entries })
        .from(pricingCatalogs)
        .where(eq(pricingCatalogs.pending, true));
      expect(pending?.entries).toMatchObject({ primary: { "claude-opus-5": repricedOpus } });

      yield* valuePending(1);
      const beforeSwap = yield* db
        .select({ n: count() })
        .from(modelRequests)
        .where(eq(modelRequests.modelId, "grouped-elsewhere"));
      expect(beforeSwap[0]?.n).toBe(0);
      expect(yield* counts).toEqual(baseline);
      yield* valuePending(1000);
      const afterSwap = yield* db
        .select({ n: count() })
        .from(modelRequests)
        .where(eq(modelRequests.modelId, "grouped-elsewhere"));
      expect(afterSwap[0]?.n).toBeGreaterThan(0);
      expect(
        yield* db.select().from(pricingCatalogs).where(eq(pricingCatalogs.pending, true)),
      ).toEqual([]);
    }),
  );
});

test("a rule saved while a refresh is in flight stays in the refreshed catalog", async () => {
  const upstream = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}"))),
  );
  await runTest(
    Effect.gen(function* () {
      const db = yield* Db;
      const saveRule = upsertRule("racing-model", {
        kind: "rate",
        inputPerMillion: 100,
        outputPerMillion: 100,
      });
      yield* refreshPricing().pipe(
        Effect.provideService(Db, commitBeforeTransaction(db, saveRule)),
        Effect.provideService(HttpClient.HttpClient, upstream),
      );
      const pending = yield* db
        .select({ entries: pricingCatalogs.entries })
        .from(pricingCatalogs)
        .where(eq(pricingCatalogs.pending, true));
      expect(pending).toMatchObject([{ entries: { rules: { "racing-model": { kind: "rate" } } } }]);
    }),
  );
});

test("reprocessing keeps a pending catalog, which takes over once it has priced the rebuilt requests", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      yield* applyBatch(
        machineA,
        batch("36363636-0000-4000-8000-000000000001", machineA, fixtureRecords()),
      );
      yield* workOnce();
      const version = yield* insertRepricedCatalog();
      yield* activateCatalog(version);
      yield* reprocessArchive();
      yield* workOnce();
      const [active] = yield* db
        .select({ version: pricingCatalogs.version })
        .from(pricingCatalogs)
        .where(eq(pricingCatalogs.active, true));
      expect(active?.version).toBe(version);
    }),
  );
});

test("only the active catalog and the three most recent superseded ones keep their valuations", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      yield* applyBatch(
        machineA,
        batch("12121212-0000-4000-8000-000000000001", machineA, fixtureRecords()),
      );
      yield* workOnce();
      const versions: Array<string> = [];
      for (const step of [1, 2, 3, 4, 5]) {
        const version = yield* insertRepricedCatalog([step * 1e-5, 5e-5, 1.25e-5, 1e-6, 2]);
        yield* activateCatalog(version);
        yield* workOnce();
        versions.push(version);
      }
      const kept = yield* db
        .selectDistinct({ version: valuations.catalogVersion })
        .from(valuations);
      expect(kept.map((row) => row.version).toSorted()).toEqual(versions.slice(1).toSorted());
    }),
  );
});

test("a conversation parsed by an older parser version is queued again", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      yield* applyBatch(
        machineA,
        batch("cdcdcdcd-0000-4000-8000-000000000001", machineA, fixtureRecords()),
      );
      yield* workOnce();
      expect(yield* queueStale()).toBe(0);
      yield* db.update(conversations).set({ parserVersion: 0 });
      expect(yield* queueStale()).toBe(1);
      yield* workOnce();
      const [row] = yield* db.select({ version: conversations.parserVersion }).from(conversations);
      expect(row?.version).toBe(claudeNormalizer.parserVersion);
    }),
  );
});

test("commits link to the tightest conversation window on the same project path and follow deletions", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const db = yield* Db;
      yield* applyBatch(
        machineA,
        batch("77777777-0000-4000-8000-000000000001", machineA, fixtureRecords()),
      );
      yield* workOnce();
      const [fixtureConversation] = yield* db
        .select({ id: conversations.id, projectPath: conversations.projectPath })
        .from(conversations);
      const projectPath = fixtureConversation?.projectPath ?? "";
      expect(projectPath).toBe("/home/dev/project");

      const tasks = yield* repositoryTasks(machineA);
      expect(tasks).toEqual([{ path: projectPath, since: "2026-09-21T09:00:00.000Z" }]);

      const repo = "github.com/acme/project";
      const sha = (n: number) => n.toString(16).padStart(40, "0");
      const commit = (n: number, authoredAt: string, ref = "main", onDefaultBranch = true) => ({
        repo,
        sha: sha(n),
        parents: n === 1 ? [] : [sha(n - 1)],
        authoredAt,
        committedAt: authoredAt,
        subject: `commit ${n}`,
        ref,
        onDefaultBranch,
      });
      const result = yield* applyCommitBatch(machineA, {
        machineId: machineA,
        repositories: [{ path: projectPath, repo, remote: repo }],
        commits: [
          commit(1, "2026-09-21T09:00:30.000Z"),
          commit(2, "2026-09-21T10:01:00.000Z"),
          commit(3, "2026-09-21T12:00:00.000Z", "feature", false),
        ],
      });
      expect(result).toEqual({ repositories: 1, commits: 3 });
      const linked = yield* commitsForConversation(fixtureConversation?.id ?? "");
      expect(linked.map((row) => row.sha)).toEqual([sha(2), sha(1)]);
      expect(linked[0]?.remote).toBe(repo);

      const [tighter] = yield* db
        .insert(conversations)
        .values({
          provider: "claude",
          conversationKey: "tighter-window",
          projectPath,
          projectKey: "project",
          gitBranch: "main",
          startedAt: new Date("2026-09-21T09:00:20.000Z"),
          endedAt: new Date("2026-09-21T09:00:40.000Z"),
          parserVersion: 1,
        })
        .returning({ id: conversations.id });
      yield* db
        .insert(conversationMachines)
        .values({ conversationId: tighter?.id ?? "", machineId: machineA });
      yield* relinkConversations([tighter?.id ?? ""]);
      expect((yield* commitsForConversation(tighter?.id ?? "")).map((row) => row.sha)).toEqual([
        sha(1),
      ]);
      expect(
        (yield* commitsForConversation(fixtureConversation?.id ?? "")).map((row) => row.sha),
      ).toEqual([sha(2)]);
      expect((yield* commitsForProject("project")).map((row) => row.sha)).toEqual([sha(2), sha(1)]);

      yield* deleteConversation(tighter?.id ?? "");
      expect((yield* commitsForProject("project")).map((row) => row.sha)).toEqual([sha(2)]);
    }),
  );
});

test("analysis buckets every priced request exactly once and exposes per-conversation turns", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      yield* applyBatch(
        machineA,
        batch("66666666-0000-4000-8000-000000000001", machineA, fixtureRecords()),
      );
      yield* workOnce();
      const stats = yield* computeStats({});
      const analysis = yield* computeAnalysis({});
      const categoryTotal = analysis.byCategory.reduce((sum, row) => sum + row.costUsd, 0);
      expect(categoryTotal + analysis.unattributedCostUsd).toBeCloseTo(stats.overall.costUsd, 6);
      expect(analysis.attributedCostUsd).toBeCloseTo(categoryTotal, 6);
      expect(analysis.byModel.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(
        categoryTotal,
        6,
      );
      expect(analysis.byCategory.length).toBeGreaterThan(0);

      const db = yield* Db;
      const [conversation] = yield* db
        .select({ id: conversations.id })
        .from(conversations)
        .limit(1);
      const detail = yield* getConversation(conversation?.id ?? "");
      expect(detail.turns.length).toBe(
        analysis.byCategory.reduce((sum, row) => sum + row.turns, 0),
      );
      expect(detail.turns.reduce((sum, turn) => sum + turn.requests, 0)).toBe(
        stats.overall.requests,
      );
      expect(analysis.byModel.reduce((sum, row) => sum + row.requests, 0)).toBe(
        stats.overall.requests,
      );
      expect(detail.turns[0]?.userExcerpt).not.toBe("");
      expect(yield* computeAnalysis({ provider: "codex" })).toMatchObject({
        byCategory: [],
        attributedCostUsd: 0,
        unattributedCostUsd: 0,
      });
    }),
  );
});

test("concurrent retries acknowledge one batch exactly once", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const records = fixtureRecords();
      const input = batch("99999999-0000-4000-8000-000000000001", machineA, records);
      const results = yield* Effect.all(
        [applyBatch(machineA, input), applyBatch(machineA, input)],
        { concurrency: 2 },
      );
      expect(results[0]).toEqual(results[1]);
      expect(results[0]?.accepted).toBe(records.length);
      const db = yield* Db;
      const [stored] = yield* db.select({ n: count() }).from(sourceRecords);
      expect(stored?.n).toBe(records.length);
    }),
  );
});

test("a machine cannot reuse another machine's batch acknowledgement", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachines;
      const id = "99999999-0000-4000-8000-000000000002";
      yield* applyBatch(machineA, batch(id, machineA, fixtureRecords()));
      const rejected = yield* applyBatch(machineB, batch(id, machineB, [])).pipe(Effect.flip);
      expect(rejected._tag).toBe("BadRequest");
    }),
  );
});

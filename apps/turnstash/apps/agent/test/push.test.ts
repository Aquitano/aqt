import { expect, test } from "bun:test";

import { CurrentActor, ingestGroup, MachineAuth } from "@aqt/turnstash-api";
import {
  ConversationKey,
  type IngestResult,
  MachineId,
  RecordKey,
  sha256Hex,
  streamIdOf,
  type Tombstone,
} from "@aqt/turnstash-core";
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient, type HttpClient, HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";

import { apiClientFor, push } from "../src/push.ts";
import { AgentState } from "../src/state.ts";

const machineId = MachineId.make("d4aa4082-eaf3-4de6-acb0-23985c26d539");
const now = "2026-09-21T00:00:00.000Z";
const TestApi = HttpApi.make("test").add(ingestGroup).prefix("/api");

const MachineAuthLive = Layer.succeed(
  MachineAuth,
  MachineAuth.of({
    bearer: (httpEffect) =>
      Effect.provideService(httpEffect, CurrentActor, { kind: "machine", machineId }),
  }),
);

const makeServer = (
  tombstones: ReadonlyArray<Tombstone> = [
    {
      provider: "claude",
      conversationKey: ConversationKey.make("gone"),
      deletedAt: "2026-09-21T00:00:00.000Z",
    },
  ],
) => {
  const applied = new Map<string, IngestResult>();
  const seenRecords: Array<string> = [];
  const tombstoneQueries: Array<string | null> = [];
  const IngestLive = HttpApiBuilder.group(TestApi, "ingest", (handlers) =>
    handlers
      .handle("pushBatch", ({ payload }) =>
        Effect.sync(() => {
          const stored = applied.get(payload.batchId);
          if (stored) return stored;
          seenRecords.push(...payload.records.map((record) => record.recordKey));
          const result = {
            batchId: payload.batchId,
            accepted: payload.records.length,
            duplicates: 0,
            replaced: 0,
          };
          applied.set(payload.batchId, result);
          return result;
        }),
      )
      .handle("tombstones", ({ query }) =>
        Effect.sync(() => {
          tombstoneQueries.push(query.since ?? null);
          return tombstones;
        }),
      )
      .handle("repositories", () => Effect.succeed([]))
      .handle("pushCommits", ({ payload }) =>
        Effect.succeed({
          repositories: payload.repositories.length,
          commits: payload.commits.length,
        }),
      ),
  );
  const web = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(TestApi).pipe(
      Layer.provide(IngestLive),
      Layer.provide(MachineAuthLive),
      Layer.provide(BunHttpServer.layerHttpServices),
    ),
  );
  return { applied, seenRecords, tombstoneQueries, handler: web.handler, dispose: web.dispose };
};

const source = {
  kind: "jsonl" as const,
  root: { path: "/a", label: "test" },
  relativePath: "s.jsonl",
};
const streamId = streamIdOf(source);
const record = (key: string) => ({
  provider: "claude" as const,
  streamId,
  recordKey: RecordKey.make(key),
  payload: key,
  contentHash: sha256Hex(key),
  observedAt: now,
  redactions: 0,
});

// SAFETY: the client only ever calls fetch; Bun's extra preconnect static is never used.
const fetchVia = (handler: (request: Request) => Promise<Response>) =>
  ((input: string | URL | Request, init?: RequestInit) =>
    handler(input instanceof Request ? input : new Request(String(input), init))) as typeof fetch;

const runPush = <A, E>(
  fetchImpl: typeof fetch,
  effect: Effect.Effect<A, E, AgentState.Service | HttpClient.HttpClient>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(AgentState.layer(":memory:")),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImpl)),
    ),
  );

test("a batch whose ack is lost is retried with the same id and applied once", async () => {
  const server = makeServer();
  let dropNextAck = true;
  const fetchImpl = fetchVia(async (request) => {
    const response = await server.handler(request);
    if (dropNextAck && request.url.endsWith("/api/ingest/batches")) {
      dropNextAck = false;
      throw new TypeError("connection reset");
    }
    return response;
  });
  const summary = await runPush(
    fetchImpl,
    Effect.gen(function* () {
      const state = yield* AgentState.Service;
      yield* state.commitScan(
        "claude",
        streamId,
        { byteOffset: 4 },
        [record("0"), record("2")],
        now,
      );
      const client = yield* apiClientFor("http://turnstash.test", Redacted.make("machine-token"));
      const result = yield* push(client, { machineId, agentVersion: "test" });
      return {
        ...result,
        pending: yield* state.pendingCount(),
        tombstoned: (yield* state.tombstonedKeys("claude")).has("gone"),
      };
    }),
  );
  expect(summary).toEqual({
    batches: 1,
    accepted: 2,
    duplicates: 0,
    replaced: 0,
    refused: 0,
    requeued: 0,
    tombstones: 1,
    pending: 0,
    tombstoned: true,
  });
  expect(server.applied.size).toBe(1);
  expect(server.seenRecords).toEqual(["0", "2"]);
  await server.dispose();
});

test("large outboxes are pushed in concurrent batches and every record lands once", async () => {
  const server = makeServer();
  const fetchImpl = fetchVia(server.handler);
  const keys = Array.from({ length: 1200 }, (_, index) => String(index));
  const summary = await runPush(
    fetchImpl,
    Effect.gen(function* () {
      const state = yield* AgentState.Service;
      yield* state.commitScan("claude", streamId, { byteOffset: 4 }, keys.map(record), now);
      const client = yield* apiClientFor("http://turnstash.test", Redacted.make("machine-token"));
      const result = yield* push(client, { machineId, agentVersion: "test" });
      return { ...result, pending: yield* state.pendingCount() };
    }),
  );
  expect(summary.batches).toBe(3);
  expect(summary.accepted).toBe(1200);
  expect(summary.pending).toBe(0);
  expect([...server.seenRecords].sort()).toEqual([...keys].sort());
  await server.dispose();
});

test("a batch the server refuses is split until the refused record is set aside", async () => {
  const server = makeServer();
  const fetchImpl = fetchVia(async (request) => {
    if ((await request.clone().text()).includes('"recordKey":"bad"'))
      return new Response("<html>too large</html>", { status: 413 });
    return server.handler(request);
  });
  const summary = await runPush(
    fetchImpl,
    Effect.gen(function* () {
      const state = yield* AgentState.Service;
      yield* state.commitScan(
        "claude",
        streamId,
        { byteOffset: 4 },
        ["a", "b", "bad", "c", "d"].map(record),
        now,
      );
      const client = yield* apiClientFor("http://turnstash.test", Redacted.make("machine-token"));
      const result = yield* push(client, { machineId, agentVersion: "test" });
      return {
        accepted: result.accepted,
        refused: result.refused,
        pending: yield* state.pendingCount(),
        rejected: (yield* state.rejectedRecords()).map((row) => [
          String(row.recordKey),
          row.reason,
        ]),
      };
    }),
  );
  expect(summary).toEqual({ accepted: 4, refused: 1, pending: 0, rejected: [["bad", "refused"]] });
  expect([...server.seenRecords].sort()).toEqual(["a", "b", "c", "d"]);
  await server.dispose();
});

test("a refused record stays parked for the version that refused it and is resent after an upgrade", async () => {
  const server = makeServer();
  let refuse = true;
  const fetchImpl = fetchVia(async (request) => {
    if (refuse && request.url.endsWith("/api/ingest/batches"))
      return new Response("<html>bad request</html>", { status: 400 });
    return server.handler(request);
  });
  const summary = await runPush(
    fetchImpl,
    Effect.gen(function* () {
      const state = yield* AgentState.Service;
      yield* state.commitScan("claude", streamId, { byteOffset: 4 }, [record("a")], now);
      const client = yield* apiClientFor("http://turnstash.test", Redacted.make("machine-token"));
      const refused = yield* push(client, { machineId, agentVersion: "1" });
      refuse = false;
      const sameVersion = yield* push(client, { machineId, agentVersion: "1" });
      const parked = (yield* state.rejectedRecords()).length;
      const upgraded = yield* push(client, { machineId, agentVersion: "2" });
      return {
        refused: refused.refused,
        sameVersion: [sameVersion.requeued, sameVersion.accepted],
        parked,
        upgraded: [upgraded.requeued, upgraded.accepted],
        rejected: (yield* state.rejectedRecords()).length,
      };
    }),
  );
  expect(summary).toEqual({
    refused: 1,
    sameVersion: [0, 0],
    parked: 1,
    upgraded: [1, 1],
    rejected: 0,
  });
  expect(server.seenRecords).toEqual(["a"]);
  await server.dispose();
});

test("the tombstone cursor follows the server's newest deletion, not the agent clock", async () => {
  const newest = "2026-09-21T12:00:00.000Z";
  const server = makeServer([
    { provider: "claude", conversationKey: ConversationKey.make("late"), deletedAt: newest },
    {
      provider: "claude",
      conversationKey: ConversationKey.make("early"),
      deletedAt: "2026-09-20T08:00:00.000Z",
    },
  ]);
  const fetchImpl = fetchVia(server.handler);
  const cursor = await runPush(
    fetchImpl,
    Effect.gen(function* () {
      const state = yield* AgentState.Service;
      const client = yield* apiClientFor("http://turnstash.test", Redacted.make("machine-token"));
      yield* push(client, { machineId, agentVersion: "test" });
      yield* push(client, { machineId, agentVersion: "test" });
      return yield* state.getMeta("tombstones_since");
    }),
  );
  expect(cursor).toBe(newest);
  expect(server.tombstoneQueries).toEqual([null, newest]);
  await server.dispose();
});

test("replayed tombstones count once while later deletions in the same millisecond are saved", async () => {
  const cursor = "2026-09-21T12:00:00.123Z";
  const tombstones: Array<Tombstone> = [
    { provider: "claude", conversationKey: ConversationKey.make("first"), deletedAt: cursor },
  ];
  const server = makeServer(tombstones);
  try {
    const result = await runPush(
      fetchVia(server.handler),
      Effect.gen(function* () {
        const state = yield* AgentState.Service;
        yield* state.setMeta("tombstones_since", cursor);
        const client = yield* apiClientFor("http://turnstash.test", Redacted.make("machine-token"));
        const first = yield* push(client, { machineId, agentVersion: "test" });
        tombstones.push({
          provider: "claude",
          conversationKey: ConversationKey.make("second"),
          deletedAt: cursor,
        });
        const second = yield* push(client, { machineId, agentVersion: "test" });
        const replay = yield* push(client, { machineId, agentVersion: "test" });
        return {
          counts: [first.tombstones, second.tombstones, replay.tombstones],
          keys: [...(yield* state.tombstonedKeys("claude"))].sort(),
        };
      }),
    );
    expect(result).toEqual({ counts: [1, 1, 0], keys: ["first", "second"] });
    expect(server.tombstoneQueries).toEqual([cursor, cursor, cursor]);
  } finally {
    await server.dispose();
  }
});

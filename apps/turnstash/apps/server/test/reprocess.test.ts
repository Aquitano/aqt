import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  MachineId,
  parseJsonObject,
  RecordKey,
  sha256Hex,
  type SourceDescriptor,
  StreamId,
  streamIdOf,
  type WireRecord,
} from "@aqt/turnstash-core";
import { asc, eq, sql } from "drizzle-orm";
import { Deferred, Effect, Fiber } from "effect";

import { getBlob, setRecordBlobs } from "../src/blobs.ts";
import { deleteConversation } from "../src/conversations.ts";
import { Db, inTransaction } from "../src/db/client.ts";
import {
  blobs,
  conversations,
  machines,
  messages,
  modelRequests,
  recordBlobs,
  sourceRecords,
} from "../src/db/schema.ts";
import { applyBatch } from "../src/ingest.ts";
import { Normalizers } from "../src/registry.ts";
import { reprocessArchive } from "../src/reprocess.ts";
import { workOnce } from "../src/worker.ts";
import { runTest } from "./support.ts";

setDefaultTimeout(30_000);

const machineId = MachineId.make("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const observedAt = "2026-10-17T10:00:00.000Z";

const insertMachine = Effect.flatMap(Db, (db) =>
  db
    .insert(machines)
    .values({ id: machineId, name: "a", os: "linux", arch: "x64", tokenHash: sha256Hex("a") }),
);

const wire = (
  provider: WireRecord["provider"],
  streamId: StreamId,
  recordKey: string,
  payload: string,
): WireRecord => ({
  provider,
  streamId,
  recordKey: RecordKey.make(recordKey),
  contentHash: sha256Hex(payload),
  payload,
  observedAt,
  redactions: 0,
});

const ingest = (batchId: string, records: ReadonlyArray<WireRecord>) =>
  applyBatch(machineId, { batchId, machineId, agentVersion: "test", records });

const rollout =
  "sessions/2026/09/20/rollout-2026-09-20T10-58-17-00000000-0000-7000-0000-00000000bbbb.jsonl";

const codexRecords = (): ReadonlyArray<WireRecord> => {
  const text = readFileSync(
    fileURLToPath(
      new URL(`../../../packages/providers/test/fixtures/codex/${rollout}`, import.meta.url),
    ),
    "utf8",
  );
  const streamId = StreamId.make(`fixture/jsonl/${rollout}`);
  const records: Array<WireRecord> = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.trim() !== "") records.push(wire("codex", streamId, String(offset), line));
    offset += Buffer.byteLength(line) + 1;
  }
  return records;
};

const stored = Effect.gen(function* () {
  const db = yield* Db;
  return yield* db
    .select({ hash: sourceRecords.contentHash, payload: sourceRecords.payload })
    .from(sourceRecords)
    .orderBy(asc(sourceRecords.id));
});

const conversation = Effect.gen(function* () {
  const db = yield* Db;
  return {
    messages: yield* db
      .select({ key: messages.messageKey, parts: messages.parts, text: messages.text })
      .from(messages)
      .orderBy(asc(messages.seq)),
    requests: yield* db
      .select({ key: modelRequests.requestKey, output: modelRequests.outputTokens })
      .from(modelRequests)
      .orderBy(asc(modelRequests.requestKey)),
  };
});

test("reprocessing trims records stored before their provider's trim and rebuilds the same conversation", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachine;
      const { codex, ...rest } = yield* Normalizers;
      const untrimmed = {
        ...rest,
        codex: {
          id: codex.id,
          parserVersion: codex.parserVersion,
          conversationKeyOf: codex.conversationKeyOf,
          normalize: codex.normalize,
        },
      };
      yield* ingest("11111111-0000-4000-8000-000000000001", codexRecords()).pipe(
        Effect.provideService(Normalizers, untrimmed),
      );
      yield* workOnce();
      const before = yield* stored;
      const built = yield* conversation;
      expect(before.some((row) => row.payload.includes("encrypted_content"))).toBe(true);

      const result = yield* reprocessArchive();
      expect(result.trimmed).toBeGreaterThan(0);
      expect(result.queued).toBe(1);
      yield* workOnce();

      const after = yield* stored;
      expect(after.map((row) => row.hash)).toEqual(before.map((row) => row.hash));
      expect(after.some((row) => row.payload.includes("encrypted_content"))).toBe(false);
      expect(yield* conversation).toEqual(built);
    }),
  );
});

const image = "iVBOR".padEnd(2000, "A");
const imageData = Buffer.from(image, "base64");
const imageSha256 = sha256Hex(imageData);

const claudePrompt = (session: string) =>
  wire(
    "claude",
    StreamId.make(`fixture/jsonl/projects/example-slug/${session}.jsonl`),
    "0",
    JSON.stringify({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000001",
      sessionId: session,
      timestamp: "2026-10-17T09:00:00.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
        ],
      },
    }),
  );

test("inline images move into blobs under their sha256, on ingest and when reprocessing older records", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachine;
      const db = yield* Db;
      const prompt = claudePrompt("22222222-2222-4222-8222-222222222222");
      yield* ingest("11111111-0000-4000-8000-000000000003", [prompt]);
      const ingested = yield* stored;
      expect(ingested.map((row) => row.hash)).toEqual([prompt.contentHash]);
      expect(ingested.map((row) => row.payload.includes("iVBOR"))).toEqual([false]);
      expect(yield* getBlob(imageSha256)).toEqual(imageData);

      // An archive written before images moved out of their records.
      yield* db.update(sourceRecords).set({ payload: prompt.payload });
      yield* db.delete(recordBlobs);
      yield* db.delete(blobs);
      expect((yield* reprocessArchive()).trimmed).toBe(1);
      expect(yield* stored).toEqual(ingested);
      expect(yield* getBlob(imageSha256)).toEqual(imageData);
      yield* workOnce();
      const { messages: built } = yield* conversation;
      expect(built.flatMap((message) => message.parts)).toContainEqual({
        type: "image",
        mediaType: "image/png",
        bytes: 1500,
        sha256: imageSha256,
      });
    }),
  );
});

test("reprocessing retains old blob references when a record also gains an attachment", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachine;
      const db = yield* Db;
      const prompt = claudePrompt("22222222-2222-4222-8222-222222222222");
      yield* ingest("11111111-0000-4000-8000-000000000005", [prompt]);
      const [archived] = yield* stored;
      const document = Buffer.alloc(1200, 42);
      yield* db.update(sourceRecords).set({
        payload: JSON.stringify(
          Object.assign({}, parseJsonObject(archived!.payload), {
            document: { type: "base64", data: document.toString("base64") },
          }),
        ),
      });
      expect((yield* reprocessArchive()).trimmed).toBe(1);
      expect(yield* getBlob(imageSha256)).toEqual(imageData);
      expect(yield* getBlob(sha256Hex(document))).toEqual(document);
      expect((yield* db.select().from(recordBlobs)).length).toBe(2);
      expect((yield* reprocessArchive()).trimmed).toBe(0);
      expect(yield* getBlob(imageSha256)).toEqual(imageData);
    }),
  );
});

test("replacing a record cleans up only its removed blob references", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachine;
      const db = yield* Db;
      const prompt = claudePrompt("22222222-2222-4222-8222-222222222222");
      yield* ingest("11111111-0000-4000-8000-000000000006", [prompt]);
      const unrelated = Buffer.from("unrelated");
      yield* db.insert(blobs).values({ sha256: sha256Hex(unrelated), data: unrelated });
      const payload = prompt.payload.replace(image, "AA==");
      yield* ingest("11111111-0000-4000-8000-000000000007", [
        {
          ...prompt,
          payload,
          contentHash: sha256Hex(payload),
        },
      ]);
      expect(
        (yield* db.select({ sha256: blobs.sha256 }).from(blobs))
          .map((row) => row.sha256)
          .toSorted(),
      ).toEqual([sha256Hex(unrelated), sha256Hex(Buffer.from([0]))].toSorted());
      expect(yield* getBlob(sha256Hex(Buffer.from([0])))).toEqual(Buffer.from([0]));
    }),
  );
});

test("removing the last blob reference waits for a concurrent upload of the same bytes", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachine;
      const db = yield* Db;
      yield* ingest("11111111-0000-4000-8000-000000000008", [
        claudePrompt("33333333-3333-4333-8333-333333333333"),
        claudePrompt("44444444-4444-4444-8444-444444444444"),
      ]);
      const [first, second] = yield* db.select({ id: sourceRecords.id }).from(sourceRecords);
      const empty = { blobs: new Map<string, Buffer>(), sha256s: new Set<string>() };
      yield* inTransaction(setRecordBlobs([{ id: second!.id, ...empty }]));
      const uploaded = yield* Deferred.make<number>();
      const removing = yield* Deferred.make<number>();
      const release = yield* Deferred.make<void>();
      const uploading = yield* inTransaction(
        Effect.gen(function* () {
          const tx = yield* Db;
          const [backend] = yield* tx.execute<{ pid: number }>(
            sql`SELECT pg_backend_pid() AS pid`,
            "objects",
          );
          yield* setRecordBlobs([
            {
              id: second!.id,
              blobs: new Map([[imageSha256, imageData]]),
              sha256s: new Set([imageSha256]),
            },
          ]);
          yield* Deferred.succeed(uploaded, backend!.pid);
          yield* Deferred.await(release);
        }),
      ).pipe(Effect.forkScoped);
      const uploaderPid = yield* Deferred.await(uploaded);
      const removal = yield* inTransaction(
        Effect.gen(function* () {
          const tx = yield* Db;
          const [backend] = yield* tx.execute<{ pid: number }>(
            sql`SELECT pg_backend_pid() AS pid`,
            "objects",
          );
          yield* Deferred.succeed(removing, backend!.pid);
          yield* setRecordBlobs([{ id: first!.id, ...empty }]);
        }),
      ).pipe(Effect.forkScoped);
      const removerPid = yield* Deferred.await(removing);
      yield* Effect.gen(function* () {
        while (true) {
          const [state] = yield* db.execute<{ blocked: boolean }>(
            sql`SELECT ${uploaderPid} = ANY(pg_blocking_pids(${removerPid})) AS blocked`,
            "objects",
          );
          if (state?.blocked) return;
        }
      }).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(uploading);
      yield* Fiber.join(removal);
      expect(
        yield* db.select().from(recordBlobs).where(eq(recordBlobs.recordId, second!.id)),
      ).toEqual([{ recordId: second!.id, sha256: imageSha256 }]);
      expect(yield* getBlob(imageSha256)).toEqual(imageData);
    }).pipe(Effect.scoped),
  );
});

test("an image in two conversations is stored once and deleted with the last of them", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachine;
      const db = yield* Db;
      yield* ingest("11111111-0000-4000-8000-000000000004", [
        claudePrompt("33333333-3333-4333-8333-333333333333"),
        claudePrompt("44444444-4444-4444-8444-444444444444"),
      ]);
      yield* workOnce();
      const storedHashes = db.select({ sha256: blobs.sha256 }).from(blobs);
      expect(yield* storedHashes).toEqual([{ sha256: imageSha256 }]);

      const [first, second] = yield* db.select({ id: conversations.id }).from(conversations);
      yield* deleteConversation(first!.id);
      expect(yield* storedHashes).toEqual([{ sha256: imageSha256 }]);
      yield* deleteConversation(second!.id);
      expect(yield* storedHashes).toEqual([]);
    }),
  );
});

const opencodePart = (id: string) =>
  JSON.stringify({ id, messageID: "msg_1", sessionID: "ses_1", type: "text", text: id });

test("reprocessing removes OpenCode file store records whose readable database row the archive holds", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* insertMachine;
      const root = { path: "/home/dev/.local/share/opencode", label: "opencode" };
      const file = (relativePath: string): SourceDescriptor => ({
        kind: "json",
        root,
        relativePath,
      });
      yield* ingest("11111111-0000-4000-8000-000000000002", [
        wire(
          "opencode",
          streamIdOf({
            kind: "sqlite",
            root,
            relativePath: "opencode.db",
            table: "part",
            keyColumn: "id",
          }),
          "prt_1",
          JSON.stringify({ id: "prt_1", message_id: "msg_1", session_id: "ses_1", data: "{}" }),
        ),
        wire(
          "opencode",
          streamIdOf({
            kind: "sqlite",
            root,
            relativePath: "opencode.db",
            table: "part",
            keyColumn: "id",
          }),
          "prt_2",
          JSON.stringify({ id: "prt_2", message_id: "msg_1", session_id: "ses_1", data: "@@@" }),
        ),
        wire(
          "opencode",
          streamIdOf({
            kind: "sqlite",
            root,
            relativePath: "opencode.db",
            table: "part",
            keyColumn: "id",
          }),
          "prt_3",
          JSON.stringify({
            id: "prt_3",
            message_id: "msg_1",
            session_id: "ses_1",
            data: JSON.stringify({ text: "a\u0000b" }),
          }),
        ),
        wire(
          "opencode",
          streamIdOf({
            kind: "sqlite",
            root,
            relativePath: "opencode.db",
            table: "part",
            keyColumn: "id",
          }),
          "prt_4",
          JSON.stringify({ id: "prt_4", message_id: "msg_1", session_id: "ses_1" }),
        ),
        wire(
          "opencode",
          streamIdOf({
            kind: "sqlite",
            root,
            relativePath: "opencode.db",
            table: "part",
            keyColumn: "id",
          }),
          "prt_5",
          JSON.stringify({ id: "prt_5", message_id: "msg_1", data: "{}" }),
        ),
        wire(
          "opencode",
          streamIdOf(file("storage/part/msg_1/prt_1.json")),
          "0",
          opencodePart("prt_1"),
        ),
        wire(
          "opencode",
          streamIdOf(file("storage/part/msg_1/prt_2.json")),
          "0",
          opencodePart("prt_2"),
        ),
        wire(
          "opencode",
          streamIdOf(file("storage/part/msg_1/prt_3.json")),
          "0",
          opencodePart("prt_3"),
        ),
        wire(
          "opencode",
          streamIdOf(file("storage/part/msg_1/prt_4.json")),
          "0",
          opencodePart("prt_4"),
        ),
        wire(
          "opencode",
          streamIdOf(file("storage/part/msg_1/prt_5.json")),
          "0",
          opencodePart("prt_5"),
        ),
      ]);

      const result = yield* reprocessArchive();
      expect(result.opencodeFileTwins).toBe(1);
      expect((yield* stored).map((row) => row.payload)).not.toContain(opencodePart("prt_1"));
      expect((yield* stored).map((row) => row.payload)).toContain(opencodePart("prt_2"));
      expect((yield* stored).map((row) => row.payload)).toContain(opencodePart("prt_3"));
      expect((yield* stored).map((row) => row.payload)).toContain(opencodePart("prt_4"));
      expect((yield* stored).map((row) => row.payload)).toContain(opencodePart("prt_5"));
    }),
  );
});

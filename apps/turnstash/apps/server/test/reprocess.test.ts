import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  MachineId,
  RecordKey,
  sha256Hex,
  type SourceDescriptor,
  StreamId,
  streamIdOf,
  type WireRecord,
} from "@aqt/turnstash-core";
import { asc } from "drizzle-orm";
import { Effect } from "effect";

import { Db } from "../src/db/client.ts";
import { machines, messages, modelRequests, sourceRecords } from "../src/db/schema.ts";
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

const opencodePart = (id: string) =>
  JSON.stringify({ id, messageID: "msg_1", sessionID: "ses_1", type: "text", text: id });

test("reprocessing removes OpenCode file store records whose database row the archive holds", async () => {
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
      ]);

      const result = yield* reprocessArchive();
      expect(result.opencodeFileTwins).toBe(1);
      expect((yield* stored).map((row) => row.payload)).not.toContain(opencodePart("prt_1"));
      expect((yield* stored).map((row) => row.payload)).toContain(opencodePart("prt_2"));
    }),
  );
});

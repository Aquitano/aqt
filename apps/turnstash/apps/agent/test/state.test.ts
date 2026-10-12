import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";

import { encodedJsonBytes, MachineId, RecordKey, sha256Hex, streamIdOf } from "@aqt/turnstash-core";
import { Effect, Result } from "effect";

import { AgentState } from "../src/state.ts";
import { withDirectory } from "./support.ts";

const now = "2026-09-21T00:00:00.000Z";
const metadata = {
  batchId: "f3783344-cfdf-45ab-883c-2e132330150a",
  machineId: MachineId.make("d4aa4082-eaf3-4de6-acb0-23985c26d539"),
  agentVersion: "1",
};
const source = {
  kind: "jsonl" as const,
  root: { path: "/a", label: "test" },
  relativePath: "session.jsonl",
};
const streamId = streamIdOf(source);
const record = (key: string, payload: string) => ({
  provider: "claude" as const,
  streamId,
  recordKey: RecordKey.make(key),
  payload,
  contentHash: sha256Hex(payload),
  observedAt: now,
  redactions: 0,
});

const runState = <A, E>(path: string, effect: Effect.Effect<A, E, AgentState.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(AgentState.layer(path))));

test.skipIf(process.platform === "win32")(
  "state storage is private on creation and repairs existing permissions",
  () =>
    withDirectory(async (directory) => {
      const stateDirectory = join(directory, "state");
      const path = join(stateDirectory, "agent.db");
      for (const existing of [false, true]) {
        if (existing) {
          chmodSync(stateDirectory, 0o755);
          chmodSync(path, 0o644);
        }
        await runState(
          path,
          Effect.sync(() => {
            expect(statSync(stateDirectory).mode & 0o777).toBe(0o700);
            for (const file of [path, `${path}-wal`, `${path}-shm`]) {
              expect(statSync(file).mode & 0o777).toBe(0o600);
            }
          }),
        );
      }
    }),
);

test("scan commits isolate roots and roll back checkpoint, hashes and outbox together", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "state.db");
    await runState(
      path,
      Effect.gen(function* () {
        const state = yield* AgentState.Service;
        yield* state.commitScan(
          "claude",
          streamId,
          { byteOffset: 10 },
          [record("0", "first")],
          now,
        );
        const secondRoot = streamIdOf({ ...source, root: { path: "/b", label: "test" } });
        expect(yield* state.streamCheckpoint("claude", secondRoot)).toBeNull();
        const db = new Database(path);
        db.exec(
          "CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
        );
        db.close();
        const result = yield* state
          .commitScan("claude", streamId, { byteOffset: 20 }, [record("10", "second")], now)
          .pipe(Effect.result);
        expect(Result.isFailure(result) && result.failure._tag).toBe("SqliteError");
        expect(yield* state.streamCheckpoint("claude", streamId)).toEqual({ byteOffset: 10 });
        const known = yield* state.knownHashes("claude", streamId, [
          RecordKey.make("0"),
          RecordKey.make("10"),
        ]);
        expect([...known.keys()]).toEqual(["0"]);
        expect(yield* state.pendingCount()).toBe(1);
      }),
    );
  }));

test("batches count the encoded envelope and resume identically after reopening", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "state.db");
    const records = [record("0", '😀\\"'.repeat(100)), record("1", '😀\\"'.repeat(100))] as const;
    const maxBytes = encodedJsonBytes({ ...metadata, records: [records[0]] });
    const first = await runState(
      path,
      Effect.gen(function* () {
        const state = yield* AgentState.Service;
        yield* state.commitScan("claude", streamId, { byteOffset: 10 }, records, now);
        expect(yield* state.pendingBytes()).toBe(
          records.reduce((bytes, item) => bytes + Buffer.byteLength(item.payload), 0),
        );
        return yield* state.claimBatch(metadata, { maxBytes });
      }),
    );
    expect(first.records).toHaveLength(1);
    expect(encodedJsonBytes(first)).toBe(maxBytes);
    await runState(
      path,
      Effect.gen(function* () {
        const state = yield* AgentState.Service;
        expect(yield* state.pendingBatchId()).toBe(metadata.batchId);
        expect(yield* state.resumeBatch(metadata.batchId, metadata)).toEqual(first);
        yield* state.markDelivered(metadata.batchId);
        expect(yield* state.pendingBatchId()).toBeNull();
        expect(yield* state.pendingCount()).toBe(1);
      }),
    );
  }));

test("JSONL prefix hashes migrate with old state and survive reopening", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "state.db");
    const legacy = new Database(path);
    legacy.exec(
      "CREATE TABLE streams (provider TEXT NOT NULL, stream_id TEXT NOT NULL, byte_offset INTEGER NOT NULL DEFAULT 0, last_scanned_at TEXT NOT NULL, PRIMARY KEY (provider, stream_id))",
    );
    legacy.query("INSERT INTO streams VALUES (?, ?, ?, ?)").run("claude", streamId, 10, now);
    legacy.close();
    const checkpoint = { byteOffset: 20, prefixHash: sha256Hex("consumed bytes") };
    await runState(
      path,
      Effect.gen(function* () {
        const state = yield* AgentState.Service;
        expect(yield* state.streamCheckpoint("claude", streamId)).toEqual({ byteOffset: 10 });
        yield* state.commitScan("claude", streamId, checkpoint, [], now);
      }),
    );
    expect(
      await runState(
        path,
        Effect.flatMap(AgentState.Service, (state) => state.streamCheckpoint("claude", streamId)),
      ),
    ).toEqual(checkpoint);
  }));

test("an existing state file switches to incremental vacuum and delivered batches free their space", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "state.db");
    const legacy = new Database(path);
    legacy.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    legacy.close();
    await runState(
      path,
      Effect.gen(function* () {
        const state = yield* AgentState.Service;
        yield* state.commitScan(
          "claude",
          streamId,
          { byteOffset: 10 },
          [record("0", "x".repeat(1_000_000))],
          now,
        );
        yield* state.claimBatch(metadata);
        yield* state.markDelivered(metadata.batchId);
      }),
    );
    const db = new Database(path);
    expect(db.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
    expect(db.query("PRAGMA freelist_count").get()).toEqual({ freelist_count: 0 });
    db.close();
  }));

test("resuming a batch that a concurrent sync already delivered claims nothing", async () => {
  await runState(
    ":memory:",
    Effect.gen(function* () {
      const state = yield* AgentState.Service;
      yield* state.commitScan(
        "claude",
        streamId,
        { byteOffset: 0 },
        [record("0", "a"), record("1", "b")],
        now,
      );
      yield* state.claimBatch(metadata, { maxRecords: 1 });
      expect(yield* state.pendingBatchId()).toBe(metadata.batchId);
      yield* state.markDelivered(metadata.batchId);
      expect(yield* state.resumeBatch(metadata.batchId, metadata)).toBeNull();
      expect(yield* state.pendingBatchId()).toBeNull();
      expect(yield* state.pendingCount()).toBe(1);
    }),
  );
});

test("a record that did not fit the previous batch is claimed by the next one on the same connection", async () => {
  await runState(
    ":memory:",
    Effect.gen(function* () {
      const state = yield* AgentState.Service;
      const records = [
        record("0", "a".repeat(400)),
        record("1", "b".repeat(400)),
        record("2", "c".repeat(400)),
      ] as const;
      const maxBytes = encodedJsonBytes({ ...metadata, records: [records[0]] });
      yield* state.commitScan("claude", streamId, { byteOffset: 10 }, records, now);
      const delivered: Array<string> = [];
      for (const batchId of [
        "f3783344-cfdf-45ab-883c-2e132330150a",
        "f3783344-cfdf-45ab-883c-2e132330150b",
        "f3783344-cfdf-45ab-883c-2e132330150c",
      ]) {
        const batch = yield* state.claimBatch({ ...metadata, batchId }, { maxBytes });
        delivered.push(...batch.records.map((row) => String(row.recordKey)));
        yield* state.markDelivered(batchId);
      }
      expect(delivered).toEqual(["0", "1", "2"]);
      expect(yield* state.pendingCount()).toBe(0);
    }),
  );
});

test("a newer version replaces an unsent one but leaves a version already in a batch", async () => {
  await runState(
    ":memory:",
    Effect.gen(function* () {
      const state = yield* AgentState.Service;
      yield* state.commitScan("claude", streamId, { byteOffset: 0 }, [record("0", "v1")], now);
      yield* state.commitScan("claude", streamId, { byteOffset: 0 }, [record("0", "v2")], now);
      expect(yield* state.pendingCount()).toBe(1);
      const batch = yield* state.claimBatch(metadata);
      expect(batch.records.map((row) => row.payload)).toEqual(["v2"]);
      yield* state.commitScan("claude", streamId, { byteOffset: 0 }, [record("0", "v3")], now);
      expect(yield* state.pendingCount()).toBe(2);
    }),
  );
});

test("oversized records remain inspectable without blocking valid records", async () => {
  await runState(
    ":memory:",
    Effect.gen(function* () {
      const state = yield* AgentState.Service;
      const good = record("1", "valid");
      const maxBytes = encodedJsonBytes({ ...metadata, records: [good] });
      yield* state.commitScan(
        "claude",
        streamId,
        { byteOffset: 10 },
        [record("0", "large".repeat(100)), good],
        now,
      );
      const batch = yield* state.claimBatch(metadata, { maxBytes });
      expect(batch.records).toEqual([good]);
      expect((yield* state.rejectedRecords()).map((row) => String(row.recordKey))).toEqual(["0"]);
      yield* state.markDelivered(metadata.batchId);
      expect(yield* state.pendingCount()).toBe(0);
      expect(yield* state.rejectedRecords()).toHaveLength(1);
    }),
  );
});

test("a manual retry requeues refused records, drops superseded ones and keeps size rejections", async () => {
  await runState(
    ":memory:",
    Effect.gen(function* () {
      const state = yield* AgentState.Service;
      const small = [record("a", "v1"), record("b", "b")] as const;
      const maxBytes = encodedJsonBytes({ ...metadata, records: small });
      yield* state.commitScan(
        "claude",
        streamId,
        { byteOffset: 0 },
        [record("big", "large".repeat(200)), ...small],
        now,
      );
      const refused = yield* state.claimBatch(metadata, { maxBytes });
      expect(refused.records.map((row) => String(row.recordKey))).toEqual(["a", "b"]);
      yield* state.rejectBatch(metadata.batchId, "1");
      yield* state.commitScan("claude", streamId, { byteOffset: 0 }, [record("a", "v2")], now);

      expect(yield* state.retryRefused()).toBe(1);
      expect(
        (yield* state.rejectedRecords()).map((row) => [String(row.recordKey), row.reason]),
      ).toEqual([["big", "batch-limit"]]);
      const next = yield* state.claimBatch({
        ...metadata,
        batchId: "f3783344-cfdf-45ab-883c-2e132330150b",
      });
      expect(next.records.map((row) => row.payload)).toEqual(["b", "v2"]);
    }),
  );
});

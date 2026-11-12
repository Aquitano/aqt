import { expect, test } from "bun:test";

import { MachineId, type T3Run } from "@aqt/turnstash-core";
import { Effect } from "effect";

import { Db } from "../src/db/client.ts";
import { conversations, machines } from "../src/db/schema.ts";
import { ensureReaderRole, runQuery } from "../src/query.ts";
import { applyT3Batch } from "../src/t3.ts";
import { runTest } from "./support.ts";

const machineId = MachineId.make(crypto.randomUUID());

const run = (patch: Partial<T3Run>): T3Run => ({
  id: "run:thread:t1:ordinal:1",
  threadId: "t1",
  ordinal: 1,
  provider: "claudeAgent",
  status: "running",
  model: "claude-opus-5-5",
  effort: "high",
  fast: false,
  requestedAt: "2026-11-01T10:00:00.000Z",
  startedAt: "2026-11-01T10:00:02.000Z",
  completedAt: null,
  attempts: 1,
  nativeSessionId: "6F1C2A4E-0000-4000-8000-000000000001",
  ...patch,
});

test("a newer copy of a run replaces the stored one, an older one does not, and a retry drops the old session", async () => {
  await runTest(
    Effect.gen(function* () {
      yield* ensureReaderRole();
      const db = yield* Db;
      yield* db
        .insert(machines)
        .values({ id: machineId, name: "laptop", os: "linux", arch: "x64", tokenHash: machineId });
      const [session] = yield* db
        .insert(conversations)
        .values({
          provider: "claude",
          conversationKey: "6F1C2A4E-0000-4000-8000-000000000001",
          startedAt: new Date("2026-11-01T10:00:00Z"),
          endedAt: new Date("2026-11-01T10:05:00Z"),
          parserVersion: 1,
        })
        .returning({ id: conversations.id });

      yield* applyT3Batch(machineId, { machineId, threads: [], runs: [run({})] });
      yield* applyT3Batch(machineId, {
        machineId,
        threads: [],
        runs: [run({ status: "completed", completedAt: "2026-11-01T10:05:02.000Z" })],
      });
      yield* applyT3Batch(machineId, { machineId, threads: [], runs: [run({})] });

      const result = yield* runQuery({
        sql: "select machine, status, queued_seconds, duration_seconds, session_id from t3_runs",
      });
      expect(result.rows).toEqual([["laptop", "completed", 2, 300, session?.id ?? null]]);

      yield* applyT3Batch(machineId, {
        machineId,
        threads: [],
        runs: [
          run({ attempts: 2, nativeSessionId: null, completedAt: "2026-11-01T10:09:00.000Z" }),
        ],
      });
      const retried = yield* runQuery({ sql: "select attempts, native_session_id from t3_runs" });
      expect(retried.rows).toEqual([[2, null]]);
    }),
  );
});

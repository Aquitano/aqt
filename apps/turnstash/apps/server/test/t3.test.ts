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

test("a resent run replaces its earlier copy and joins the session it wrote", async () => {
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
          conversationKey: "6f1c2a4e-0000-4000-8000-000000000001",
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

      const { rows } = yield* runQuery({
        sql: "select machine, status, queued_seconds, duration_seconds, session_id from t3_runs",
      });
      expect(rows).toEqual([
        {
          machine: "laptop",
          status: "completed",
          queued_seconds: 2,
          duration_seconds: 300,
          session_id: session?.id ?? null,
        },
      ]);
    }),
  );
});

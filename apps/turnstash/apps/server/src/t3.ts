import type { MachineId, T3Batch, T3BatchResult } from "@aqt/turnstash-core";
import { Effect } from "effect";

import { Db } from "./db/client.ts";
import { t3Runs, t3Threads } from "./db/schema.ts";
import { excluded } from "./db/sql.ts";

const dateOrNull = (value: string | null) => (value === null ? null : new Date(value));

// The agent resends a thread or run whenever T3 may have changed it, so the latest copy wins.
export const applyT3Batch = Effect.fn("T3.applyBatch")(function* (
  machineId: MachineId,
  batch: T3Batch,
) {
  const db = yield* Db;
  if (batch.threads.length > 0)
    yield* db
      .insert(t3Threads)
      .values(
        batch.threads.map((thread) => ({
          ...thread,
          machineId,
          pullRequests: [...thread.pullRequests],
          createdAt: new Date(thread.createdAt),
          updatedAt: new Date(thread.updatedAt),
          archivedAt: dateOrNull(thread.archivedAt),
          deletedAt: dateOrNull(thread.deletedAt),
        })),
      )
      .onConflictDoUpdate({
        target: [t3Threads.machineId, t3Threads.id],
        set: excluded(t3Threads, [
          "title",
          "project",
          "projectRoot",
          "provider",
          "createdBy",
          "creationSource",
          "parentThreadId",
          "relationship",
          "model",
          "effort",
          "fast",
          "branch",
          "worktreePath",
          "pullRequests",
          "createdAt",
          "updatedAt",
          "archivedAt",
          "deletedAt",
        ]),
      });
  if (batch.runs.length > 0)
    yield* db
      .insert(t3Runs)
      .values(
        batch.runs.map((run) => ({
          ...run,
          machineId,
          requestedAt: new Date(run.requestedAt),
          startedAt: dateOrNull(run.startedAt),
          completedAt: dateOrNull(run.completedAt),
        })),
      )
      .onConflictDoUpdate({
        target: [t3Runs.machineId, t3Runs.id],
        set: excluded(t3Runs, [
          "threadId",
          "ordinal",
          "provider",
          "status",
          "model",
          "effort",
          "fast",
          "requestedAt",
          "startedAt",
          "completedAt",
          "attempts",
          "nativeSessionId",
        ]),
      });
  return { threads: batch.threads.length, runs: batch.runs.length } satisfies T3BatchResult;
});

import type { Database } from "bun:sqlite";

import {
  type HostEnv,
  IsoTimestamp,
  type MachineId,
  redact,
  type T3Run,
  type T3Thread,
  t3BatchLimits,
} from "@aqt/turnstash-core";
import { Array as Arr, DateTime, Duration, Effect, FileSystem, Option, Path, Schema } from "effect";

import type { ApiClient } from "./push.ts";
import { openSqlite, sqliteOperation } from "./sqlite.ts";
import { AgentState } from "./state.ts";

const checkpointKey = "t3_synced_until";

// T3 writes a row's timestamps before it commits the row, so the next sync looks back past its own start.
const checkpointOverlap = Duration.minutes(10);

export const t3StateDb = (host: HostEnv, path: Path.Path) => {
  const override = host.env["TURNSTASH_T3_STATE_DB"]?.trim();
  return override === undefined || override === ""
    ? path.join(host.home, ".t3", "userdata", "statev2.sqlite")
    : override;
};

const optionValue = (source: string, ids: string) =>
  `SELECT json_extract(o.value, '$.value') FROM json_each(${source}, '$.modelSelection.options') o
   WHERE json_extract(o.value, '$.id') IN (${ids}) LIMIT 1`;

// Claude marks fast mode as a boolean option and Codex as the priority service tier.
const modelSelection = (source: string) => `
  json_extract(${source}, '$.modelSelection.model') AS model,
  (${optionValue(source, "'effort', 'reasoningEffort'")}) AS effort,
  (SELECT CASE json_extract(o.value, '$.id') WHEN 'fastMode' THEN json_extract(o.value, '$.value') = 1
          ELSE json_extract(o.value, '$.value') = 'priority' END
   FROM json_each(${source}, '$.modelSelection.options') o
   WHERE json_extract(o.value, '$.id') IN ('fastMode', 'serviceTier') LIMIT 1) AS fast`;

const threadsQuery = `
  SELECT t.thread_id AS id, t.title, p.title AS project, p.workspace_root AS project_root,
         t.default_provider AS provider,
         json_extract(t.payload_json, '$.createdBy') AS created_by,
         json_extract(t.payload_json, '$.creationSource') AS creation_source,
         json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
         json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship,
         ${modelSelection("t.payload_json")},
         json_extract(t.payload_json, '$.branch') AS branch,
         json_extract(t.payload_json, '$.worktreePath') AS worktree_path,
         (SELECT json_group_array(pr.url) FROM projection_thread_pull_requests pr
          WHERE pr.thread_id = t.thread_id) AS pull_requests,
         t.created_at, t.updated_at, t.archived_at, t.deleted_at
  FROM orchestration_v2_projection_threads t
  LEFT JOIN projection_projects p ON p.project_id = t.project_id
  WHERE t.updated_at >= ?1`;

// A run is resent until it completes, so its final status and duration replace the in-flight copy.
const runsQuery = `
  SELECT r.run_id AS id, r.thread_id, r.ordinal, r.provider, r.status,
         ${modelSelection("r.payload_json")},
         r.requested_at, json_extract(r.payload_json, '$.startedAt') AS started_at, r.completed_at,
         (SELECT count(*) FROM orchestration_v2_projection_run_attempts a WHERE a.run_id = r.run_id) AS attempts,
         (SELECT json_extract(a.payload_json, '$.nativeThreadId') FROM orchestration_v2_projection_run_attempts a
          WHERE a.run_id = r.run_id ORDER BY a.attempt_ordinal DESC LIMIT 1) AS native_session_id
  FROM orchestration_v2_projection_runs r
  WHERE r.requested_at >= ?1 OR r.completed_at >= ?1 OR r.completed_at IS NULL`;

const Text = Schema.NullOr(Schema.String);
const Timestamp = Schema.NullOr(IsoTimestamp);
const Flag = Schema.NullOr(Schema.Number);

const fastOf = (value: number | null) => (value === null ? null : value === 1);
const redactedOrNull = (value: string | null) => (value === null ? null : redact(value).text);

const ThreadRow = Schema.Struct({
  id: Schema.String,
  title: Text,
  project: Text,
  project_root: Text,
  provider: Text,
  created_by: Text,
  creation_source: Text,
  parent_thread_id: Text,
  relationship: Text,
  model: Text,
  effort: Text,
  fast: Flag,
  branch: Text,
  worktree_path: Text,
  pull_requests: Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp,
  archived_at: Timestamp,
  deleted_at: Timestamp,
});

const RunRow = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  ordinal: Schema.Int,
  provider: Text,
  status: Schema.String,
  model: Text,
  effort: Text,
  fast: Flag,
  requested_at: IsoTimestamp,
  started_at: Timestamp,
  completed_at: Timestamp,
  attempts: Schema.Int,
  native_session_id: Text,
});

const threadOf = (row: typeof ThreadRow.Type): T3Thread => ({
  id: row.id,
  title: redactedOrNull(row.title),
  project: redactedOrNull(row.project),
  projectRoot: row.project_root,
  provider: row.provider,
  createdBy: row.created_by,
  creationSource: row.creation_source,
  parentThreadId: row.parent_thread_id,
  relationship: row.relationship,
  model: row.model,
  effort: row.effort,
  fast: fastOf(row.fast),
  branch: redactedOrNull(row.branch),
  worktreePath: row.worktree_path,
  pullRequests: row.pull_requests.filter((url) => url !== null),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at,
  deletedAt: row.deleted_at,
});

const runOf = (row: typeof RunRow.Type): T3Run => ({
  id: row.id,
  threadId: row.thread_id,
  ordinal: row.ordinal,
  provider: row.provider,
  status: row.status,
  model: row.model,
  effort: row.effort,
  fast: fastOf(row.fast),
  requestedAt: row.requested_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  attempts: row.attempts,
  nativeSessionId: row.native_session_id,
});

// A row T3 wrote in a shape this agent does not know is skipped, so one odd thread cannot hold back the rest.
const decodeEach = <S extends Schema.Decoder<unknown>, A>(
  schema: S,
  rows: ReadonlyArray<unknown>,
  to: (row: S["Type"]) => A,
) => {
  const decode = Schema.decodeUnknownOption(schema);
  return rows.flatMap((row) =>
    Option.match(decode(row), { onNone: () => [], onSome: (decoded) => [to(decoded)] }),
  );
};

export const readT3 = (db: Database, path: string, since: string) =>
  sqliteOperation("readT3", path, () => ({
    threads: decodeEach(ThreadRow, db.query(threadsQuery).all(since), threadOf),
    runs: decodeEach(RunRow, db.query(runsQuery).all(since), runOf),
  }));

export interface T3SyncSummary {
  readonly found: boolean;
  readonly threads: number;
  readonly runs: number;
  readonly error: string | null;
}

// T3's tables are its own and change with its releases, so a failure here is reported without failing the
// transcript sync.
export const syncT3 = (client: ApiClient, machineId: MachineId, host: HostEnv) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const state = yield* AgentState.Service;
    const file = t3StateDb(host, path);
    if (!(yield* fs.exists(file))) return { found: false, threads: 0, runs: 0, error: null };
    const startedAt = yield* DateTime.now;
    const since = (yield* state.getMeta(checkpointKey)) ?? "";
    const { threads, runs } = yield* Effect.scoped(
      Effect.flatMap(openSqlite(file, { readonly: true }), (db) => readT3(db, file, since)),
    );
    const threadBatches = Arr.chunksOf(threads, t3BatchLimits.maxRows);
    const runBatches = Arr.chunksOf(runs, t3BatchLimits.maxRows);
    for (let index = 0; index < Math.max(threadBatches.length, runBatches.length); index++) {
      yield* client.ingest.pushT3({
        payload: { machineId, threads: threadBatches[index] ?? [], runs: runBatches[index] ?? [] },
      });
    }
    yield* state.setMeta(
      checkpointKey,
      DateTime.formatIso(DateTime.subtractDuration(startedAt, checkpointOverlap)),
    );
    return { found: true, threads: threads.length, runs: runs.length, error: null };
  }).pipe(
    Effect.catch((error): Effect.Effect<T3SyncSummary> =>
      Effect.succeed({ found: true, threads: 0, runs: 0, error: error.message }),
    ),
    Effect.withSpan("T3.sync"),
  );

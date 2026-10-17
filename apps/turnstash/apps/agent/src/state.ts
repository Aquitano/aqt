import {
  encodedJsonBytes,
  IngestBatchMetadata,
  IsoTimestamp,
  WireRecord,
  type ProviderId,
  type RecordKey,
  type StreamId,
} from "@aqt/turnstash-core";
import { Context, Effect, Layer, Schema } from "effect";

import { type ExtractionLimits, extractionLimits, type SkippedRecord } from "./extract/limits.ts";
import { openSqlite, type SqliteRow, sqliteOperation } from "./sqlite.ts";

const schema = `
CREATE TABLE IF NOT EXISTS streams (
  provider TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  last_scanned_at TEXT NOT NULL,
  PRIMARY KEY (provider, stream_id)
);
CREATE TABLE IF NOT EXISTS records (
  provider TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (provider, stream_id, record_key)
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  redactions INTEGER NOT NULL,
  batch_id TEXT
);
CREATE INDEX IF NOT EXISTS outbox_batch ON outbox(batch_id);
CREATE INDEX IF NOT EXISTS outbox_record ON outbox(provider, stream_id, record_key);
CREATE TABLE IF NOT EXISTS outbox_rejections (
  outbox_id INTEGER PRIMARY KEY REFERENCES outbox(id) ON DELETE CASCADE,
  encoded_bytes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skipped_records (
  provider TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (provider, stream_id, record_key)
);
CREATE TABLE IF NOT EXISTS outbox_batches (
  batch_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  agent_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tombstones (
  provider TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  PRIMARY KEY (provider, conversation_key)
);
CREATE TABLE IF NOT EXISTS commits (
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (repo, sha)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves existing tables as they
// were, so these are added on open when missing.
const addedColumns: ReadonlyArray<{ table: string; column: string; definition: string }> = [
  {
    table: "outbox_rejections",
    column: "reason",
    definition: "TEXT NOT NULL DEFAULT 'batch-limit'",
  },
  { table: "streams", column: "fingerprint", definition: "TEXT" },
  { table: "streams", column: "prefix_hash", definition: "TEXT" },
  { table: "outbox_rejections", column: "agent_version", definition: "TEXT" },
];

const OutboxRow = Schema.Struct({ ...WireRecord.fields, id: Schema.Natural });

export const RejectionReason = Schema.Literals(["batch-limit", "refused", "read-limit"]);
export type RejectionReason = typeof RejectionReason.Type;

const RejectedRecord = Schema.Struct({
  provider: WireRecord.fields.provider,
  streamId: WireRecord.fields.streamId,
  recordKey: WireRecord.fields.recordKey,
  bytes: Schema.Natural,
  reason: RejectionReason,
});
const columns = `id, provider, stream_id AS streamId, record_key AS recordKey,
  content_hash AS contentHash, payload, observed_at AS observedAt, redactions`;

export const StreamCheckpoint = Schema.Struct({
  byteOffset: Schema.Natural,
  prefixHash: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
});
export type StreamCheckpointRow = typeof StreamCheckpoint.Type;

export class InvalidScan extends Schema.TaggedError<InvalidScan>()("InvalidScan", {
  message: Schema.String,
}) {}

export class BatchEnvelopeTooLarge extends Schema.TaggedError<BatchEnvelopeTooLarge>()(
  "BatchEnvelopeTooLarge",
  {
    maxBytes: Schema.Natural,
  },
) {}

const incrementalAutoVacuum = 2;

const make = Effect.fn("AgentState.make")(function* (path: string) {
  const db = yield* openSqlite(path, { readonly: false });
  yield* sqliteOperation("initialize", path, () => {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(schema);
    for (const { table, column, definition } of addedColumns) {
      const existing = db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
      if (!existing.includes(column))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    // Earlier agents skipped every line over the send limit and moved their checkpoints past it. Most of
    // those lines now fit without their inline images, so their streams are read again once; records
    // already sent are recognised by hash and not sent again.
    db.transaction(() => {
      const first = db
        .query("INSERT OR IGNORE INTO meta (key, value) VALUES ('reread_skipped_records', '1')")
        .run();
      if (first.changes === 0) return;
      db.run(`UPDATE streams SET byte_offset = 0, prefix_hash = NULL, fingerprint = NULL
        WHERE (provider, stream_id) IN (SELECT provider, stream_id FROM skipped_records)`);
      db.run("DELETE FROM skipped_records");
    })();
  });
  // Delivered outbox payloads leave free pages behind, gigabytes after a first sync. Incremental
  // auto-vacuum lets markDelivered return them to the file system; an existing database needs one
  // VACUUM to switch modes. That VACUUM needs the lock and free disk space, so a failure is retried on
  // the next open instead of stopping the command.
  yield* sqliteOperation("enableIncrementalVacuum", path, () => {
    const autoVacuum = db.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get();
    if (autoVacuum?.auto_vacuum === incrementalAutoVacuum) return;
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec("VACUUM");
  }).pipe(
    Effect.catchTag("SqliteError", (error) =>
      Effect.logWarning("Could not compact the agent state; retrying on the next run", error),
    ),
  );
  const rowsForBatch = (batchId: string): ReadonlyArray<WireRecord> => {
    const rows = db
      .query<SqliteRow, [string]>(`SELECT ${columns} FROM outbox WHERE batch_id = ? ORDER BY id`)
      .all(batchId);
    return Schema.decodeUnknownSync(Schema.Array(WireRecord))(rows);
  };
  return {
    streamCheckpoint: Effect.fn("AgentState.streamCheckpoint")(function* (
      provider: ProviderId,
      streamId: StreamId,
    ) {
      return yield* sqliteOperation("streamCheckpoint", path, () => {
        const row = db
          .query<{ byte_offset: number; prefix_hash: string | null }, [string, string]>(
            "SELECT byte_offset, prefix_hash FROM streams WHERE provider = ? AND stream_id = ?",
          )
          .get(provider, streamId);
        return row === null
          ? null
          : {
              byteOffset: row.byte_offset,
              ...(row.prefix_hash === null ? {} : { prefixHash: row.prefix_hash }),
            };
      });
    }),
    streamFingerprint: Effect.fn("AgentState.streamFingerprint")(function* (
      provider: ProviderId,
      streamId: StreamId,
    ) {
      return yield* sqliteOperation("streamFingerprint", path, () => {
        const row = db
          .query<{ fingerprint: string | null }, [string, string]>(
            "SELECT fingerprint FROM streams WHERE provider = ? AND stream_id = ?",
          )
          .get(provider, streamId);
        return row?.fingerprint ?? null;
      });
    }),
    markScanned: Effect.fn("AgentState.markScanned")(function* (
      provider: ProviderId,
      streamId: StreamId,
      fingerprint: string,
      scannedAt: string,
    ) {
      return yield* sqliteOperation("markScanned", path, () => {
        db.query(
          `INSERT INTO streams (provider, stream_id, last_scanned_at, fingerprint) VALUES (?, ?, ?, ?)
           ON CONFLICT(provider, stream_id) DO UPDATE SET fingerprint = excluded.fingerprint`,
        ).run(provider, streamId, scannedAt, fingerprint);
      });
    }),
    knownHashes: Effect.fn("AgentState.knownHashes")(function* (
      provider: ProviderId,
      streamId: StreamId,
      recordKeys: ReadonlyArray<RecordKey>,
    ) {
      return yield* sqliteOperation("knownHashes", path, () => {
        const rows = db
          .query<{ record_key: string; content_hash: string }, [string, string, string]>(
            `SELECT record_key, content_hash FROM records WHERE provider = ? AND stream_id = ?
             AND record_key IN (SELECT value FROM json_each(?))`,
          )
          .all(provider, streamId, JSON.stringify(recordKeys));
        return new Map(rows.map((row) => [row.record_key, row.content_hash]));
      });
    }),
    commitScan: Effect.fn("AgentState.commitScan")(function* (
      provider: ProviderId,
      streamId: StreamId,
      checkpoint: StreamCheckpointRow,
      changed: ReadonlyArray<WireRecord>,
      scannedAt: string,
      skipped: ReadonlyArray<SkippedRecord> = [],
    ) {
      yield* Schema.decodeUnknownEffect(StreamCheckpoint)(checkpoint);
      yield* Schema.decodeUnknownEffect(Schema.Array(WireRecord))(changed);
      yield* Schema.decodeUnknownEffect(IsoTimestamp)(scannedAt);
      if (changed.some((record) => record.provider !== provider || record.streamId !== streamId)) {
        return yield* Effect.fail(
          new InvalidScan({ message: "Records must belong to the scanned provider and stream" }),
        );
      }
      return yield* sqliteOperation("commitScan", path, () => {
        const upsertStream = db.query(
          `INSERT INTO streams (provider, stream_id, byte_offset, last_scanned_at, prefix_hash) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(provider, stream_id) DO UPDATE SET byte_offset = excluded.byte_offset, last_scanned_at = excluded.last_scanned_at, prefix_hash = excluded.prefix_hash`,
        );
        const upsertRecord = db.query(
          `INSERT INTO records (provider, stream_id, record_key, content_hash) VALUES (?, ?, ?, ?)
           ON CONFLICT(provider, stream_id, record_key) DO UPDATE SET content_hash = excluded.content_hash`,
        );
        // Only the newest version of a record is worth sending. With two batches in flight, an
        // older version queued behind a newer one could otherwise reach the server last.
        const supersede = db.query(
          `DELETE FROM outbox WHERE provider = ? AND stream_id = ? AND record_key = ? AND batch_id IS NULL
           AND id NOT IN (SELECT outbox_id FROM outbox_rejections)`,
        );
        const enqueue = db.query(
          `INSERT INTO outbox (provider, stream_id, record_key, content_hash, payload, observed_at, redactions)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        const skip = db.query(
          "INSERT OR REPLACE INTO skipped_records (provider, stream_id, record_key, bytes) VALUES (?, ?, ?, ?)",
        );
        const unskip = db.query(
          "DELETE FROM skipped_records WHERE provider = ? AND stream_id = ? AND record_key = ?",
        );
        db.transaction(() => {
          upsertStream.run(
            provider,
            streamId,
            checkpoint.byteOffset,
            scannedAt,
            checkpoint.prefixHash ?? null,
          );
          for (const record of skipped)
            skip.run(provider, streamId, record.recordKey, record.bytes);
          for (const record of changed) {
            upsertRecord.run(provider, streamId, record.recordKey, record.contentHash);
            unskip.run(provider, streamId, record.recordKey);
            supersede.run(provider, streamId, record.recordKey);
            enqueue.run(
              provider,
              streamId,
              record.recordKey,
              record.contentHash,
              record.payload,
              record.observedAt,
              record.redactions,
            );
          }
        })();
      });
    }),
    pendingCount: Effect.fn("AgentState.pendingCount")(function* () {
      return yield* sqliteOperation("pendingCount", path, () => {
        const row = db
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM outbox WHERE id NOT IN (SELECT outbox_id FROM outbox_rejections)",
          )
          .get();
        return row?.n ?? 0;
      });
    }),
    pendingBytes: Effect.fn("AgentState.pendingBytes")(function* () {
      return yield* sqliteOperation("pendingBytes", path, () => {
        const row = db
          .query<{ n: number | null }, []>(
            "SELECT sum(length(CAST(payload AS BLOB))) AS n FROM outbox WHERE id NOT IN (SELECT outbox_id FROM outbox_rejections)",
          )
          .get();
        return row?.n ?? 0;
      });
    }),
    claimBatch: Effect.fn("AgentState.claimBatch")(function* (
      input: IngestBatchMetadata,
      options: Partial<ExtractionLimits> = {},
    ) {
      const metadata = yield* Schema.decodeUnknownEffect(IngestBatchMetadata)(input);
      const { maxRecords, maxBytes } = yield* extractionLimits(options);
      if (encodedJsonBytes({ ...metadata, records: [] }) > maxBytes) {
        return yield* Effect.fail(new BatchEnvelopeTooLarge({ maxBytes }));
      }
      // Immediate, because a deferred transaction that reads before writing fails at once with
      // SQLITE_BUSY_SNAPSHOT when another sync commits in between, without waiting on busy_timeout.
      return yield* sqliteOperation("claimBatch", path, () => {
        const claim = db.transaction(() => {
          let bytes = encodedJsonBytes({ ...metadata, records: [] });
          const claimed: Array<number> = [];
          // A cached statement left mid-iteration by an early break resumes after the break point on the next
          // claim, silently skipping the row that did not fit, so the candidates are read eagerly.
          const pending = db
            .query<SqliteRow, [number]>(
              `SELECT ${columns} FROM outbox WHERE batch_id IS NULL
           AND id NOT IN (SELECT outbox_id FROM outbox_rejections) ORDER BY id LIMIT ?`,
            )
            .all(maxRecords);
          const reject = db.query(
            "INSERT INTO outbox_rejections (outbox_id, encoded_bytes, reason) VALUES (?, ?, 'batch-limit')",
          );
          for (const row of pending) {
            const { id, ...record } = Schema.decodeUnknownSync(OutboxRow)(row);
            const recordBytes = encodedJsonBytes(record);
            const singleBatchBytes = encodedJsonBytes({ ...metadata, records: [record] });
            if (singleBatchBytes > maxBytes) {
              reject.run(id, singleBatchBytes);
              continue;
            }
            const addedBytes = recordBytes + (claimed.length > 0 ? 1 : 0);
            if (bytes + addedBytes > maxBytes) break;
            claimed.push(id);
            bytes += addedBytes;
            if (claimed.length === maxRecords) break;
          }
          const mark = db.query("UPDATE outbox SET batch_id = ? WHERE id = ?");
          for (const id of claimed) mark.run(metadata.batchId, id);
          if (claimed.length > 0) {
            db.query(
              "INSERT INTO outbox_batches (batch_id, machine_id, agent_version) VALUES (?, ?, ?)",
            ).run(metadata.batchId, metadata.machineId, metadata.agentVersion);
          }
          return { ...metadata, records: rowsForBatch(metadata.batchId) };
        });
        return claim.immediate();
      });
    }),
    // A batch left claimed by an interrupted run, or still in flight in a concurrent one. Unlike
    // claimBatch it never claims new records: once the other run delivers the batch, its id is spent,
    // and the server would acknowledge new records under it without storing them.
    resumeBatch: Effect.fn("AgentState.resumeBatch")(function* (
      batchId: string,
      identity: Omit<IngestBatchMetadata, "batchId">,
    ) {
      return yield* sqliteOperation("resumeBatch", path, () =>
        db.transaction(() => {
          const records = rowsForBatch(batchId);
          if (records.length === 0) return null;
          const saved = db
            .query<{ batchId: string; machineId: string; agentVersion: string }, [string]>(
              "SELECT batch_id AS batchId, machine_id AS machineId, agent_version AS agentVersion FROM outbox_batches WHERE batch_id = ?",
            )
            .get(batchId);
          return {
            ...Schema.decodeUnknownSync(IngestBatchMetadata)(saved ?? { batchId, ...identity }),
            records,
          };
        })(),
      );
    }),
    pendingBatchId: Effect.fn("AgentState.pendingBatchId")(function* () {
      return yield* sqliteOperation("pendingBatchId", path, () => {
        const row = db
          .query<{ batch_id: string }, []>(
            "SELECT batch_id FROM outbox WHERE batch_id IS NOT NULL ORDER BY id LIMIT 1",
          )
          .get();
        return row?.batch_id ?? null;
      });
    }),
    releaseBatch: Effect.fn("AgentState.releaseBatch")(function* (batchId: string) {
      return yield* sqliteOperation("releaseBatch", path, () => {
        db.transaction(() => {
          db.query("UPDATE outbox SET batch_id = NULL WHERE batch_id = ?").run(batchId);
          db.query("DELETE FROM outbox_batches WHERE batch_id = ?").run(batchId);
        })();
      });
    }),
    rejectBatch: Effect.fn("AgentState.rejectBatch")(function* (
      batchId: string,
      agentVersion: string,
    ) {
      return yield* sqliteOperation("rejectBatch", path, () => {
        db.transaction(() => {
          const reject = db.query(
            "INSERT OR REPLACE INTO outbox_rejections (outbox_id, encoded_bytes, reason, agent_version) VALUES (?, ?, 'refused', ?)",
          );
          const rows = db
            .query<SqliteRow, [string]>(`SELECT ${columns} FROM outbox WHERE batch_id = ?`)
            .all(batchId);
          for (const row of rows) {
            const { id, ...record } = Schema.decodeUnknownSync(OutboxRow)(row);
            reject.run(id, encodedJsonBytes(record), agentVersion);
          }
          db.query("UPDATE outbox SET batch_id = NULL WHERE batch_id = ?").run(batchId);
          db.query("DELETE FROM outbox_batches WHERE batch_id = ?").run(batchId);
        }).immediate();
      });
    }),
    // Puts refused records back in the outbox, or only those an agent other than `keepRefusedBy`
    // refused. A refused record whose newer version is already queued is dropped instead, so only the
    // newest version is ever sent. Size rejections stay: they fail the same way every time.
    retryRefused: Effect.fn("AgentState.retryRefused")(function* (keepRefusedBy?: string) {
      return yield* sqliteOperation("retryRefused", path, () => {
        const refused =
          keepRefusedBy === undefined
            ? "SELECT outbox_id FROM outbox_rejections WHERE reason = 'refused'"
            : "SELECT outbox_id FROM outbox_rejections WHERE reason = 'refused' AND agent_version IS NOT ?1";
        const bindings = keepRefusedBy === undefined ? [] : [keepRefusedBy];
        return db.transaction(() => {
          db.query(
            `DELETE FROM outbox WHERE id IN (${refused}) AND EXISTS (
               SELECT 1 FROM outbox AS newer WHERE newer.provider = outbox.provider
                 AND newer.stream_id = outbox.stream_id AND newer.record_key = outbox.record_key
                 AND newer.id > outbox.id)`,
          ).run(...bindings);
          return db
            .query(`DELETE FROM outbox_rejections WHERE outbox_id IN (${refused})`)
            .run(...bindings).changes;
        })();
      });
    }),
    rejectedRecords: Effect.fn("AgentState.rejectedRecords")(function* () {
      return yield* sqliteOperation("rejectedRecords", path, () => {
        const rows = db
          .query<SqliteRow, []>(
            `SELECT o.provider, o.stream_id AS streamId, o.record_key AS recordKey,
               r.encoded_bytes AS bytes, r.reason FROM outbox o JOIN outbox_rejections r ON r.outbox_id = o.id
             UNION ALL
             SELECT provider, stream_id AS streamId, record_key AS recordKey, bytes, 'read-limit' AS reason
               FROM skipped_records`,
          )
          .all();
        return Schema.decodeUnknownSync(Schema.Array(RejectedRecord))(rows);
      });
    }),
    markDelivered: Effect.fn("AgentState.markDelivered")(function* (batchId: string) {
      return yield* sqliteOperation("markDelivered", path, () => {
        db.transaction(() => {
          db.query("DELETE FROM outbox WHERE batch_id = ?").run(batchId);
          db.query("DELETE FROM outbox_batches WHERE batch_id = ?").run(batchId);
        })();
        db.exec("PRAGMA incremental_vacuum");
      });
    }),
    addTombstones: Effect.fn("AgentState.addTombstones")(function* (
      rows: ReadonlyArray<{ provider: ProviderId; conversationKey: string }>,
    ) {
      return yield* sqliteOperation("addTombstones", path, () => {
        const insert = db.query(
          "INSERT OR IGNORE INTO tombstones (provider, conversation_key) VALUES (?, ?)",
        );
        return db.transaction(() => {
          let added = 0;
          for (const row of rows) added += insert.run(row.provider, row.conversationKey).changes;
          return added;
        })();
      });
    }),
    tombstonedKeys: Effect.fn("AgentState.tombstonedKeys")(function* (provider: ProviderId) {
      return yield* sqliteOperation("tombstonedKeys", path, () => {
        const rows = db
          .query<{ conversation_key: string }, [string]>(
            "SELECT conversation_key FROM tombstones WHERE provider = ?",
          )
          .all(provider);
        return new Set(rows.map((row) => row.conversation_key));
      });
    }),
    commitFingerprints: Effect.fn("AgentState.commitFingerprints")(function* (repo: string) {
      return yield* sqliteOperation("commitFingerprints", path, () => {
        const rows = db
          .query<{ sha: string; fingerprint: string }, [string]>(
            "SELECT sha, fingerprint FROM commits WHERE repo = ?",
          )
          .all(repo);
        return new Map(rows.map((row) => [row.sha, row.fingerprint]));
      });
    }),
    rememberCommits: Effect.fn("AgentState.rememberCommits")(function* (
      repo: string,
      rows: ReadonlyArray<{ readonly sha: string; readonly fingerprint: string }>,
    ) {
      return yield* sqliteOperation("rememberCommits", path, () => {
        const upsert = db.query(
          "INSERT INTO commits (repo, sha, fingerprint) VALUES (?, ?, ?) ON CONFLICT(repo, sha) DO UPDATE SET fingerprint = excluded.fingerprint",
        );
        db.transaction(() => {
          for (const row of rows) upsert.run(repo, row.sha, row.fingerprint);
        })();
      });
    }),
    getMeta: Effect.fn("AgentState.getMeta")(function* (key: string) {
      return yield* sqliteOperation("getMeta", path, () => {
        const row = db
          .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
          .get(key);
        return row?.value ?? null;
      });
    }),
    setMeta: Effect.fn("AgentState.setMeta")(function* (key: string, value: string) {
      return yield* sqliteOperation("setMeta", path, () => {
        db.query(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(key, value);
      });
    }),
  };
});

export type Interface = Effect.Success<ReturnType<typeof make>>;
export class Service extends Context.Service<Service, Interface>()("@turnstash/AgentState") {}
export const layer = (path: string) => Layer.effect(Service, make(path));
export * as AgentState from "./state.ts";

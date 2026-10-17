import {
  filePathOf,
  type HostEnv,
  type ProviderId,
  type RawRecord,
  redact,
  sha256Hex,
  type SourceDescriptor,
  type SourceProvider,
  type SourceRoot,
  streamIdOf,
  type WireRecord,
} from "@aqt/turnstash-core";
import { Clock, DateTime, Effect, FileSystem, Option, Path, Result } from "effect";

import pkg from "../package.json" with { type: "json" };
import { type JsonlCheckpoint, openJsonl, extractWholeFile } from "./extract/jsonl.ts";
import type { SkippedRecord } from "./extract/limits.ts";
import { extractSqliteTable, type SqliteKey } from "./extract/sqlite.ts";
import { Providers } from "./providers.ts";
import { AgentState } from "./state.ts";

export interface CollectProgress {
  readonly provider: ProviderId;
  readonly scanned: number;
  readonly total: number;
}

export interface CollectOptions {
  readonly host: HostEnv;
  readonly providers?: ReadonlyArray<ProviderId> | undefined;
  readonly dryRun?: boolean | undefined;
  readonly onProgress?: ((progress: CollectProgress) => Effect.Effect<void>) | undefined;
}

export interface CollectError {
  readonly provider: ProviderId;
  readonly path: string;
  readonly error: string;
}

export interface ProviderSummary {
  readonly streams: number;
  readonly records: number;
}

export interface CollectSummary {
  readonly byProvider: Partial<Record<ProviderId, ProviderSummary>>;
  readonly records: number;
  readonly errors: ReadonlyArray<CollectError>;
}

const describeError = (error: Error & { readonly _tag: string }): string => {
  const message =
    error.message === "" && error.cause instanceof Error ? error.cause.message : error.message;
  return message === "" ? error._tag : `${error._tag}: ${message}`;
};

// A write in the same clock tick as the scan can leave size and mtime unchanged, so a file touched
// this recently is scanned again next time rather than trusted.
const settledAfterMillis = 2000;

// Includes the agent version so an upgrade that changes extraction or redaction rescans each
// source once. Null means the source must be scanned.
const fingerprintOf = Effect.fn("Agent.fingerprintOf")(function* (
  descriptor: SourceDescriptor,
  absolutePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const now = yield* Clock.currentTimeMillis;
  const main = yield* fs.stat(absolutePath);
  const wal =
    descriptor.kind === "sqlite"
      ? yield* fs.stat(`${absolutePath}-wal`).pipe(
          Effect.map(Option.some),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
        )
      : Option.none();
  const parts = [pkg.version];
  for (const info of [Option.some(main), wal]) {
    if (Option.isNone(info)) {
      parts.push("-");
      continue;
    }
    if (Option.isNone(info.value.mtime)) return null;
    const mtime = info.value.mtime.value.getTime();
    if (now - mtime < settledAfterMillis) return null;
    parts.push(`${info.value.size}:${mtime}`);
  }
  return parts.join("|");
});

const scanDescriptor = Effect.fn("Agent.scanDescriptor")(function* (
  provider: ProviderId,
  descriptor: SourceDescriptor,
  dryRun: boolean,
) {
  const path = yield* Path.Path;
  const state = yield* AgentState.Service;
  const { conversationKeyOf } = yield* Providers;
  const streamId = streamIdOf(descriptor);
  const absolutePath = path.join(descriptor.root.path, filePathOf(descriptor));
  const fingerprint = yield* fingerprintOf(descriptor, absolutePath);
  if (fingerprint !== null && (yield* state.streamFingerprint(provider, streamId)) === fingerprint)
    return 0;
  const tombstoned = yield* state.tombstonedKeys(provider);
  const observedAt = DateTime.formatIso(yield* DateTime.now);

  const changedOf = Effect.fn("Agent.changedOf")(function* (records: ReadonlyArray<RawRecord>) {
    if (records.length === 0) return [];
    const known = yield* state.knownHashes(
      provider,
      streamId,
      records.map((record) => record.recordKey),
    );
    return records.flatMap((record): ReadonlyArray<WireRecord> => {
      const redacted = redact(record.payload);
      const contentHash = sha256Hex(redacted.text);
      if (known.get(record.recordKey) === contentHash) return [];
      if (tombstoned.size > 0) {
        const key = conversationKeyOf(provider, streamId, redacted.text);
        if (Option.isSome(key) && tombstoned.has(key.value)) return [];
      }
      return [
        {
          provider,
          streamId,
          recordKey: record.recordKey,
          contentHash,
          payload: redacted.text,
          observedAt,
          redactions: redacted.count,
        },
      ];
    });
  });

  const commit = (
    checkpoint: JsonlCheckpoint,
    changed: ReadonlyArray<WireRecord>,
    skipped: ReadonlyArray<SkippedRecord> = [],
  ) =>
    dryRun
      ? Effect.void
      : state.commitScan(provider, streamId, checkpoint, changed, observedAt, skipped);

  let records = 0;
  switch (descriptor.kind) {
    case "jsonl": {
      yield* Effect.gen(function* () {
        const checkpoint = (yield* state.streamCheckpoint(provider, streamId)) ?? { byteOffset: 0 };
        const readPage = yield* openJsonl(
          streamId,
          absolutePath,
          checkpoint,
          descriptor.compression,
        );
        while (true) {
          const page = yield* readPage();
          const changed = yield* changedOf(page.records);
          yield* commit(page.checkpoint, changed, page.skipped);
          records += changed.length;
          if (!page.hasMore) break;
        }
      }).pipe(Effect.scoped);
      break;
    }
    case "json": {
      const extracted =
        descriptor.readRecords === undefined
          ? [yield* extractWholeFile(streamId, absolutePath)]
          : yield* descriptor.readRecords(streamId, absolutePath);
      const changed = yield* changedOf(extracted);
      yield* commit({ byteOffset: 0 }, changed);
      records += changed.length;
      break;
    }
    case "sqlite": {
      let after: SqliteKey | undefined;
      while (true) {
        const page = yield* extractSqliteTable(
          streamId,
          absolutePath,
          descriptor,
          after === undefined ? {} : { after },
        );
        const changed = yield* changedOf(page.records);
        yield* commit({ byteOffset: 0 }, changed, page.skipped);
        records += changed.length;
        if (page.nextKey === null) break;
        after = page.nextKey;
      }
      break;
    }
  }
  if (!dryRun && fingerprint !== null)
    yield* state.markScanned(provider, streamId, fingerprint, observedAt);
  return records;
});

const scanRoot = Effect.fn("Agent.scanRoot")(function* (
  source: SourceProvider,
  root: SourceRoot,
  dryRun: boolean,
  onProgress: (progress: CollectProgress) => Effect.Effect<void>,
) {
  const errors: Array<CollectError> = [];
  yield* onProgress({ provider: source.id, scanned: 0, total: 0 });
  const discovered = yield* source.discover(root).pipe(Effect.result);
  if (Result.isFailure(discovered)) {
    errors.push({ provider: source.id, path: root.path, error: describeError(discovered.failure) });
    return { streams: 0, records: 0, errors };
  }
  let records = 0;
  for (const [index, descriptor] of discovered.success.entries()) {
    yield* onProgress({ provider: source.id, scanned: index, total: discovered.success.length });
    const scanned = yield* scanDescriptor(source.id, descriptor, dryRun).pipe(Effect.result);
    if (Result.isFailure(scanned)) {
      errors.push({
        provider: source.id,
        path: `${root.path}/${filePathOf(descriptor)}`,
        error: describeError(scanned.failure),
      });
    } else {
      records += scanned.success;
    }
  }
  return { streams: discovered.success.length, records, errors };
});

export const collect = Effect.fn("Agent.collect")(function* (options: CollectOptions) {
  const { sources } = yield* Providers;
  const selected = sources.filter(
    (source) => options.providers === undefined || options.providers.includes(source.id),
  );
  const byProvider: Partial<Record<ProviderId, ProviderSummary>> = {};
  const errors: Array<CollectError> = [];
  let records = 0;
  for (const source of selected) {
    const summary = { streams: 0, records: 0 };
    for (const root of source.roots(options.host)) {
      const scanned = yield* scanRoot(
        source,
        root,
        options.dryRun ?? false,
        options.onProgress ?? (() => Effect.void),
      );
      summary.streams += scanned.streams;
      summary.records += scanned.records;
      errors.push(...scanned.errors);
    }
    byProvider[source.id] = summary;
    records += summary.records;
  }
  return { byProvider, records, errors } satisfies CollectSummary;
});

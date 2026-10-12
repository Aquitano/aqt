import type { Effect, Option, Schema } from "effect";
import type { FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { sha256Hex } from "./hash.ts";
import type { HostEnv } from "./host.ts";
import type { NormalizedConversation } from "./normalized.ts";
import type { ProviderId } from "./provider.ts";
import { StreamId, type RecordKey } from "./records.ts";

export interface SourceRoot {
  readonly path: string;
  readonly label: string;
}

export interface JsonlSource {
  readonly kind: "jsonl";
  readonly root: SourceRoot;
  readonly relativePath: string;
}

export interface JsonFileSource {
  readonly kind: "json";
  readonly root: SourceRoot;
  readonly relativePath: string;
  readonly readRecords?: (
    streamId: StreamId,
    absolutePath: string,
  ) => Effect.Effect<
    ReadonlyArray<RawRecord>,
    PlatformError | Schema.SchemaError,
    FileSystem.FileSystem | Path.Path
  >;
}

export interface SqliteTableSource {
  readonly kind: "sqlite";
  readonly root: SourceRoot;
  readonly relativePath: string;
  readonly table: string;
  readonly keyColumn: string;
  readonly where?: string;
}

export type SourceDescriptor = JsonlSource | JsonFileSource | SqliteTableSource;

export const streamIdOf = (source: SourceDescriptor): StreamId =>
  StreamId.make(
    `${sha256Hex(source.root.path.replaceAll("\\", "/").replace(/\/+$/, ""))}/${source.kind}/${
      source.kind === "sqlite"
        ? `${source.relativePath}#${encodeURIComponent(source.table)}`
        : source.relativePath
    }`,
  );

export interface StreamParts {
  readonly kind: string;
  readonly relativePath: string;
}

export const streamPartsOf = (streamId: string): StreamParts | undefined => {
  const rootEnd = streamId.indexOf("/");
  const kindEnd = streamId.indexOf("/", rootEnd + 1);
  return rootEnd < 0 || kindEnd < 0
    ? undefined
    : { kind: streamId.slice(rootEnd + 1, kindEnd), relativePath: streamId.slice(kindEnd + 1) };
};

export const sqliteTableOf = (stream: StreamParts | undefined): string | undefined => {
  if (stream?.kind !== "sqlite") return undefined;
  const separator = stream.relativePath.lastIndexOf("#");
  if (separator < 0) return undefined;
  const table = stream.relativePath.slice(separator + 1);
  try {
    return decodeURIComponent(table);
  } catch {
    return table;
  }
};

export interface RawRecord {
  readonly streamId: StreamId;
  readonly recordKey: RecordKey;
  readonly payload: string;
}

export interface SourceProvider {
  readonly id: ProviderId;
  readonly roots: (host: HostEnv) => ReadonlyArray<SourceRoot>;
  readonly discover: (
    root: SourceRoot,
  ) => Effect.Effect<
    ReadonlyArray<SourceDescriptor>,
    PlatformError | Schema.SchemaError,
    FileSystem.FileSystem | Path.Path
  >;
}

export interface SourceRecordRow {
  readonly streamId: StreamId;
  readonly recordKey: RecordKey;
  readonly payload: string;
  readonly observedAt: string;
}

export interface Normalizer {
  readonly id: ProviderId;
  readonly parserVersion: number;
  readonly conversationKeyOf: (streamId: StreamId, payload: string) => Option.Option<string>;
  readonly normalize: (
    conversationKey: string,
    records: ReadonlyArray<SourceRecordRow>,
  ) => NormalizedConversation | null;
}

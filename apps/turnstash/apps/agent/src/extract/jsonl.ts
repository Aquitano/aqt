import { createHash, type Hash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";

import {
  type JsonlSource,
  omitInlineBlobs,
  RecordKey,
  type RawRecord,
  type StreamId,
} from "@aqt/turnstash-core";
import { Effect, FileSystem, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

import {
  type ExtractionLimits,
  extractionLimits,
  RecordTooLarge,
  type SkippedRecord,
} from "./limits.ts";

export interface JsonlCheckpoint {
  readonly byteOffset: number;
  readonly prefixHash?: string;
}

export interface JsonlExtraction {
  readonly records: ReadonlyArray<RawRecord>;
  readonly skipped: ReadonlyArray<SkippedRecord>;
  readonly checkpoint: JsonlCheckpoint;
  readonly hasMore: boolean;
}

const newline = 0x0a;

export class CompressedFileUnreadable extends Schema.TaggedError<CompressedFileUnreadable>()(
  "CompressedFileUnreadable",
  { path: Schema.String },
) {}

// The reads a JSONL page needs, so a decompressed file pages exactly like one on disk.
interface ByteSource {
  readonly size: bigint;
  readonly seek: (offset: number) => Effect.Effect<void, PlatformError>;
  readonly read: (buffer: Uint8Array) => Effect.Effect<number, PlatformError>;
}

const openFile = Effect.fn("Extract.openFile")(function* (absolutePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* fs.open(absolutePath);
  const info = yield* file.stat;
  return {
    size: info.size,
    seek: (offset) => Effect.asVoid(file.seek(BigInt(offset), "start")),
    read: (buffer) => file.read(buffer),
  } satisfies ByteSource;
});

// Compressed files are finished sessions, so they are decompressed whole rather than streamed.
const openZstd = Effect.fn("Extract.openZstd")(function* (absolutePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const compressed = yield* fs.readFile(absolutePath);
  const bytes = yield* Effect.try({
    try: () => zstdDecompressSync(compressed),
    catch: () => new CompressedFileUnreadable({ path: absolutePath }),
  });
  let position = 0;
  return {
    size: BigInt(bytes.length),
    seek: (offset) =>
      Effect.sync(() => {
        position = offset;
      }),
    read: (buffer) =>
      Effect.sync(() => {
        const chunk = bytes.subarray(position, position + buffer.length);
        buffer.set(chunk);
        position += chunk.length;
        return chunk.length;
      }),
  } satisfies ByteSource;
});

// Offset just past the next newline at or after `from`, or null when the line is not finished yet.
// Every byte read is fed into `hash`.
const endOfLine = Effect.fn("Extract.endOfLine")(function* (
  file: ByteSource,
  from: number,
  hash: Hash,
) {
  yield* file.seek(from);
  const chunk = new Uint8Array(64 * 1024);
  let position = from;
  while (true) {
    const read = yield* file.read(chunk);
    if (read === 0) return null;
    const index = chunk.subarray(0, read).indexOf(newline);
    hash.update(chunk.subarray(0, index >= 0 ? index + 1 : read));
    if (index >= 0) return position + index + 1;
    position += read;
  }
});

// Sized for the bytes the file had at stat time, and grown if it has more by now, so an ordinary
// read does not allocate the full limit.
const readBytes = Effect.fn("Extract.readBytes")(function* (
  file: ByteSource,
  maxBytes: number,
  expectedBytes: number,
) {
  let buffer = new Uint8Array(Math.max(1, Math.min(maxBytes, expectedBytes + 1)));
  let length = 0;
  while (length < maxBytes) {
    if (length === buffer.length) {
      const grown = new Uint8Array(Math.min(maxBytes, buffer.length * 2));
      grown.set(buffer);
      buffer = grown;
    }
    const read = yield* file.read(buffer.subarray(length));
    if (read === 0) break;
    length += read;
  }
  return buffer.subarray(0, length);
});

// Bounds the memory one oversized line may take while its inline blobs are omitted.
const maxLineBytes = 64 * 1024 * 1024;

// A line over the send limit is almost always inline images. Without them it usually fits, so it is
// sent with each image replaced by its size; undefined means it still does not fit.
const fittedLine = Effect.fn("Extract.fittedLine")(function* (
  file: ByteSource,
  from: number,
  to: number,
  maxBytes: number,
) {
  const length = to - from;
  if (length > maxLineBytes) return undefined;
  yield* file.seek(from);
  const line = yield* readBytes(file, length, length);
  const contentEnd = line[length - 2] === 0x0d ? length - 2 : length - 1;
  const payload = omitInlineBlobs(new TextDecoder().decode(line.subarray(0, contentEnd)));
  return Buffer.byteLength(payload) <= maxBytes ? payload : undefined;
});

// A reader keeps the rolling hash and file open across pages. Checking a saved prefix costs one
// sequential read per scan, rather than rereading every previous page as the checkpoint advances.
export const openJsonl = Effect.fn("Extract.openJsonl")(function* (
  streamId: StreamId,
  absolutePath: string,
  checkpoint: JsonlCheckpoint,
  compression?: JsonlSource["compression"],
) {
  const offset = yield* Schema.decodeUnknownEffect(Schema.Natural)(checkpoint.byteOffset);
  const file = yield* compression === "zstd" ? openZstd(absolutePath) : openFile(absolutePath);
  let start = 0;
  let hash = createHash("sha256");
  if (offset > 0 && file.size >= BigInt(offset) && checkpoint.prefixHash !== undefined) {
    const chunk = new Uint8Array(64 * 1024);
    while (start < offset) {
      const read = yield* file.read(chunk.subarray(0, Math.min(chunk.length, offset - start)));
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      start += read;
    }
    if (start !== offset || hash.copy().digest("hex") !== checkpoint.prefixHash) {
      start = 0;
      hash = createHash("sha256");
    }
  }
  const currentCheckpoint = (): JsonlCheckpoint =>
    start === 0 ? { byteOffset: 0 } : { byteOffset: start, prefixHash: hash.copy().digest("hex") };

  return Effect.fn("Extract.jsonlPage")(function* (options: Partial<ExtractionLimits> = {}) {
    const limits = yield* extractionLimits(options);
    if (file.size === BigInt(start)) {
      return {
        records: [],
        skipped: [],
        checkpoint: currentCheckpoint(),
        hasMore: false,
      } satisfies JsonlExtraction;
    }
    yield* file.seek(start);
    const bytes = yield* readBytes(file, limits.maxBytes + 1, Number(file.size) - start);
    const decoder = new TextDecoder();
    const records: Array<RawRecord> = [];
    let lineStart = 0;
    for (let i = 0; i < Math.min(bytes.length, limits.maxBytes); i += 1) {
      if (bytes[i] !== newline) continue;
      const lineEnd = bytes[i - 1] === 0x0d ? i - 1 : i;
      if (lineEnd > lineStart) {
        const payload = decoder.decode(bytes.subarray(lineStart, lineEnd));
        if (payload.trim().length > 0) {
          records.push({ streamId, recordKey: RecordKey.make(String(start + lineStart)), payload });
        }
      }
      lineStart = i + 1;
      if (records.length === limits.maxRecords) break;
    }
    // A line that does not fit even without its inline blobs can never be sent. Skipping it once it is
    // complete keeps the lines after it flowing instead of failing on it every pass.
    if (lineStart === 0 && bytes.length > limits.maxBytes) {
      // An incomplete oversized line leaves both the checkpoint and its digest unchanged.
      const extended = hash.copy().update(bytes.subarray(0, limits.maxBytes));
      const end = yield* endOfLine(file, start + limits.maxBytes, extended);
      if (end === null)
        return {
          records: [],
          skipped: [],
          checkpoint: currentCheckpoint(),
          hasMore: false,
        } satisfies JsonlExtraction;
      const recordKey = RecordKey.make(String(start));
      const payload = yield* fittedLine(file, start, end, limits.maxBytes);
      const bytesRead = end - start;
      start = end;
      hash = extended;
      return {
        records: payload === undefined ? [] : [{ streamId, recordKey, payload }],
        skipped: payload === undefined ? [{ recordKey, bytes: bytesRead }] : [],
        checkpoint: currentCheckpoint(),
        hasMore: BigInt(end) < file.size,
      } satisfies JsonlExtraction;
    }
    hash.update(bytes.subarray(0, lineStart));
    start += lineStart;
    return {
      records,
      skipped: [],
      checkpoint: currentCheckpoint(),
      hasMore:
        lineStart > 0 &&
        BigInt(start) < file.size &&
        (records.length === limits.maxRecords ||
          bytes.length > limits.maxBytes ||
          BigInt(start - lineStart + bytes.length) < file.size),
    } satisfies JsonlExtraction;
  });
});

export const extractJsonl = Effect.fn("Extract.jsonl")(function* (
  streamId: StreamId,
  absolutePath: string,
  checkpoint: JsonlCheckpoint,
  options: Partial<ExtractionLimits> = {},
) {
  const readPage = yield* openJsonl(streamId, absolutePath, checkpoint);
  return yield* readPage(options);
}, Effect.scoped);

export const extractWholeFile = Effect.fn("Extract.wholeFile")(function* (
  streamId: StreamId,
  absolutePath: string,
  options: Partial<ExtractionLimits> = {},
) {
  const limits = yield* extractionLimits(options);
  const file = yield* openFile(absolutePath);
  const bytes = yield* readBytes(file, limits.maxBytes + 1, Number(file.size));
  if (bytes.length > limits.maxBytes) {
    return yield* Effect.fail(
      new RecordTooLarge({ path: absolutePath, maxBytes: limits.maxBytes }),
    );
  }
  return {
    streamId,
    recordKey: RecordKey.make("0"),
    payload: new TextDecoder().decode(bytes),
  } satisfies RawRecord;
}, Effect.scoped);

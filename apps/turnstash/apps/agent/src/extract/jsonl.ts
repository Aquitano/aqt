import { createHash, type Hash } from "node:crypto";

import { RecordKey, type RawRecord, type StreamId } from "@aqt/turnstash-core";
import { Effect, FileSystem, Schema } from "effect";

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

// Offset just past the next newline at or after `from`, or null when the line is not finished yet.
// Every byte read is fed into `hash`.
const endOfLine = Effect.fn("Extract.endOfLine")(function* (
  file: FileSystem.File,
  from: number,
  hash: Hash,
) {
  yield* file.seek(BigInt(from), "start");
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
  file: FileSystem.File,
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

// A reader keeps the rolling hash and file open across pages. Checking a saved prefix costs one
// sequential read per scan, rather than rereading every previous page as the checkpoint advances.
export const openJsonl = Effect.fn("Extract.openJsonl")(function* (
  streamId: StreamId,
  absolutePath: string,
  checkpoint: JsonlCheckpoint,
) {
  const offset = yield* Schema.decodeUnknownEffect(Schema.Natural)(checkpoint.byteOffset);
  const fs = yield* FileSystem.FileSystem;
  const file = yield* fs.open(absolutePath);
  const info = yield* file.stat;
  let start = 0;
  let hash = createHash("sha256");
  if (offset > 0 && info.size >= BigInt(offset) && checkpoint.prefixHash !== undefined) {
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
    if (info.size === BigInt(start)) {
      return {
        records: [],
        skipped: [],
        checkpoint: currentCheckpoint(),
        hasMore: false,
      } satisfies JsonlExtraction;
    }
    yield* file.seek(BigInt(start), "start");
    const bytes = yield* readBytes(file, limits.maxBytes + 1, Number(info.size) - start);
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
    // A line longer than the limit can never be sent. Skipping it once it is complete keeps the lines
    // after it flowing instead of failing on it every pass.
    if (lineStart === 0 && bytes.length > limits.maxBytes) {
      // An incomplete oversized line leaves both the checkpoint and its digest unchanged.
      const extended = hash.copy().update(bytes.subarray(0, limits.maxBytes));
      const end = yield* endOfLine(file, start + limits.maxBytes, extended);
      const skipped =
        end === null ? [] : [{ recordKey: RecordKey.make(String(start)), bytes: end - start }];
      if (end !== null) {
        start = end;
        hash = extended;
      }
      return {
        records: [],
        skipped,
        checkpoint: currentCheckpoint(),
        hasMore: end !== null && BigInt(end) < info.size,
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
        BigInt(start) < info.size &&
        (records.length === limits.maxRecords ||
          bytes.length > limits.maxBytes ||
          BigInt(start - lineStart + bytes.length) < info.size),
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
  const fs = yield* FileSystem.FileSystem;
  const file = yield* fs.open(absolutePath);
  const info = yield* file.stat;
  const bytes = yield* readBytes(file, limits.maxBytes + 1, Number(info.size));
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

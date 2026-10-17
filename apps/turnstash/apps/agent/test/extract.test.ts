import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";

import { sha256Hex, StreamId } from "@aqt/turnstash-core";
import { Effect, Result } from "effect";

import { extractJsonl, extractWholeFile, openJsonl } from "../src/extract/jsonl.ts";
import { extractSqliteTable } from "../src/extract/sqlite.ts";
import { run, withDirectory } from "./support.ts";

const streamId = StreamId.make("session");

test("JSONL pages preserve byte offsets, partial lines and shrink resets", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "session.jsonl");
    const firstLine = '{"text":"é😀"}\r\n';
    await Bun.write(path, `${firstLine}{}\n{"partial":`);
    const first = await run(extractJsonl(streamId, path, { byteOffset: 0 }, { maxRecords: 1 }));
    expect(first.records.map((record) => record.payload)).toEqual(['{"text":"é😀"}']);
    expect(first.checkpoint.byteOffset).toBe(Buffer.byteLength(firstLine));
    expect(first.hasMore).toBe(true);
    const second = await run(extractJsonl(streamId, path, first.checkpoint));
    expect(second.records.map((record) => String(record.recordKey))).toEqual([
      String(Buffer.byteLength(firstLine)),
    ]);
    expect(second.hasMore).toBe(false);
    await Bun.write(path, `${firstLine}{}\n{"partial":true}\n`);
    const third = await run(extractJsonl(streamId, path, second.checkpoint));
    expect(third.records.map((record) => record.payload)).toEqual(['{"partial":true}']);
    await Bun.write(path, "{}\n");
    const reset = await run(extractJsonl(streamId, path, third.checkpoint));
    expect(reset.records.map((record) => String(record.recordKey))).toEqual(["0"]);
  }));

test("file extraction bounds each read and skips a line too large to send once it is complete", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "session.jsonl");
    await Bun.write(path, "{}\n{}\n{}\n");
    const page = await run(extractJsonl(streamId, path, { byteOffset: 0 }, { maxBytes: 5 }));
    expect(page.records).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.checkpoint.byteOffset).toBe(3);
    await Bun.write(path, "123456789");
    const unfinished = await run(extractJsonl(streamId, path, { byteOffset: 0 }, { maxBytes: 5 }));
    expect(unfinished).toEqual({
      records: [],
      skipped: [],
      checkpoint: { byteOffset: 0 },
      hasMore: false,
    });
    await Bun.write(path, "123456789\n{}\n");
    const skipped = await run(extractJsonl(streamId, path, { byteOffset: 0 }, { maxBytes: 5 }));
    expect(skipped.records).toEqual([]);
    expect(skipped.skipped.map((record) => [String(record.recordKey), record.bytes])).toEqual([
      ["0", 10],
    ]);
    expect(skipped.checkpoint.byteOffset).toBe(10);
    expect(skipped.hasMore).toBe(true);
    const after = await run(extractJsonl(streamId, path, skipped.checkpoint, { maxBytes: 5 }));
    expect(after.records.map((record) => record.payload)).toEqual(["{}"]);
    const whole = await run(extractWholeFile(streamId, path, { maxBytes: 5 }).pipe(Effect.result));
    expect(Result.isFailure(whole) && whole.failure._tag).toBe("RecordTooLarge");
    const missing = await run(
      extractJsonl(streamId, join(directory, "missing"), { byteOffset: 0 }).pipe(Effect.result),
    );
    expect(Result.isFailure(missing) && missing.failure._tag).toBe("PlatformError");
  }));

test("JSONL checkpoints detect larger rewrites anywhere in the consumed prefix", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "session.jsonl");
    const head = `${JSON.stringify({ text: "a".repeat(70_000) })}\n`;
    const original = `${head}{"text":"old"}\n`;
    await Bun.write(path, original);
    const first = await run(extractJsonl(streamId, path, { byteOffset: 0 }));
    expect(first.checkpoint.byteOffset).toBe(Buffer.byteLength(original));
    expect(first.checkpoint.prefixHash).toHaveLength(64);

    await Bun.write(path, `${original}{"text":"appended"}\n`);
    const appended = await run(extractJsonl(streamId, path, first.checkpoint));
    expect(appended.records.map((record) => record.payload)).toEqual(['{"text":"appended"}']);

    const rewritten = `${head}{"text":"a longer replacement"}\n{"text":"new tail"}\n`;
    await Bun.write(path, rewritten);
    const reset = await run(extractJsonl(streamId, path, appended.checkpoint, { maxRecords: 1 }));
    expect(reset.records.map((record) => String(record.recordKey))).toEqual(["0"]);
    const rest = await run(extractJsonl(streamId, path, reset.checkpoint));
    expect(rest.records.map((record) => record.payload)).toEqual([
      '{"text":"a longer replacement"}',
      '{"text":"new tail"}',
    ]);
  }));

test("legacy JSONL checkpoints without a digest rescan before trusting an offset", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "session.jsonl");
    await Bun.write(path, "{}\n{}\n");
    const page = await run(extractJsonl(streamId, path, { byteOffset: 3 }));
    expect(page.records.map((record) => String(record.recordKey))).toEqual(["0", "3"]);
    expect(page.checkpoint.prefixHash).toHaveLength(64);
  }));

test("a paged JSONL reader carries a complete prefix digest across skipped and partial lines", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "session.jsonl");
    const consumed = "{}\n123456789\n{}\n";
    await Bun.write(path, `${consumed}{"partial":`);
    const checkpoint = await run(
      Effect.gen(function* () {
        const readPage = yield* openJsonl(streamId, path, { byteOffset: 0 });
        const first = yield* readPage({ maxBytes: 5 });
        expect(first.records).toHaveLength(1);
        const skipped = yield* readPage({ maxBytes: 5 });
        expect(skipped.skipped.map((record) => String(record.recordKey))).toEqual(["3"]);
        const last = yield* readPage({ maxBytes: 5 });
        expect(last.records).toHaveLength(1);
        const partial = yield* readPage({ maxBytes: 5 });
        expect(partial.checkpoint).toEqual(last.checkpoint);
        return partial.checkpoint;
      }).pipe(Effect.scoped),
    );
    expect(checkpoint).toEqual({
      byteOffset: Buffer.byteLength(consumed),
      prefixHash: sha256Hex(consumed),
    });
    await Bun.write(path, `${consumed}{"partial":true}\n`);
    const appended = await run(extractJsonl(streamId, path, checkpoint));
    expect(appended.records.map((record) => record.payload)).toEqual(['{"partial":true}']);
  }));

test("a paged JSONL reader stops when the file shrinks between pages", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "session.jsonl");
    await Bun.write(path, "{}\n{}\n{}\n");
    const page = await run(
      Effect.gen(function* () {
        const readPage = yield* openJsonl(streamId, path, { byteOffset: 0 });
        expect((yield* readPage({ maxRecords: 1 })).hasMore).toBe(true);
        yield* Effect.promise(() => Bun.write(path, "{}\n"));
        return yield* readPage();
      }).pipe(Effect.scoped),
    );
    expect(page.records).toEqual([]);
    expect(page.hasMore).toBe(false);
  }));

test("a zstd JSONL file pages with the keys and checkpoint of the file it was compressed from", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "session.jsonl");
    const lines = '{"a":1}\n{"b":2}\n{"c":3}\n';
    await Bun.write(path, lines);
    await Bun.write(`${path}.zst`, Bun.zstdCompressSync(Buffer.from(lines)));
    const readAll = (checkpoint: { readonly byteOffset: number }) =>
      run(
        Effect.gen(function* () {
          const readPage = yield* openJsonl(streamId, `${path}.zst`, checkpoint, "zstd");
          return yield* readPage();
        }).pipe(Effect.scoped),
      );
    const plain = await run(extractJsonl(streamId, path, { byteOffset: 0 }, { maxRecords: 2 }));
    const compressed = await readAll(plain.checkpoint);
    expect(compressed.records.map((record) => String(record.recordKey))).toEqual(["16"]);
    expect(compressed.checkpoint).toEqual({
      byteOffset: Buffer.byteLength(lines),
      prefixHash: sha256Hex(lines),
    });
    const fromStart = await readAll({ byteOffset: 0 });
    expect(fromStart.records.map((record) => String(record.recordKey))).toEqual(["0", "8", "16"]);
    await Bun.write(`${path}.zst`, "not zstd");
    const corrupt = await run(
      Effect.gen(function* () {
        return yield* openJsonl(streamId, `${path}.zst`, { byteOffset: 0 }, "zstd");
      }).pipe(Effect.scoped, Effect.result),
    );
    expect(Result.isFailure(corrupt) && corrupt.failure._tag).toBe("CompressedFileUnreadable");
  }));

test("SQLite extraction pages by the native key and sees updates on a fresh scan", () =>
  withDirectory(async (directory) => {
    const path = join(directory, "source.db");
    const db = new Database(path);
    db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT, bytes BLOB)");
    for (const id of [0, 1, 2, 10])
      db.query("INSERT INTO records VALUES (?, ?, ?)").run(id, `row-${id}`, new Uint8Array([1, 2]));
    db.close();
    const source = {
      kind: "sqlite" as const,
      root: { path: directory, label: "test" },
      relativePath: "source.db",
      table: "records",
      keyColumn: "id",
      where: "id > 0",
    };
    const first = await run(extractSqliteTable(streamId, path, source, { maxRecords: 1 }));
    expect(first.records.map((record) => String(record.recordKey))).toEqual(["1"]);
    expect(first.nextKey).toBe(1);
    const next = await run(extractSqliteTable(streamId, path, source, { after: 1, maxBytes: 300 }));
    expect(next.records.map((record) => String(record.recordKey))).toEqual(["2", "10"]);
    expect(next.nextKey).toBeNull();
    expect(JSON.parse(next.records[0]?.payload ?? "")).toEqual({
      bytes: "AQI=",
      id: 2,
      value: "row-2",
    });
    const writer = new Database(path);
    writer.query("UPDATE records SET value = ? WHERE id = 1").run("changed");
    writer.close();
    const fresh = await run(extractSqliteTable(streamId, path, source, { maxRecords: 1 }));
    expect(fresh.records[0]?.payload).toContain("changed");
    const oversized = await run(extractSqliteTable(streamId, path, source, { maxBytes: 1 }));
    expect(oversized.records).toEqual([]);
    expect(oversized.skipped.map((record) => String(record.recordKey))).toEqual(["1", "2", "10"]);
    expect(oversized.nextKey).toBeNull();
    const missing = await run(extractSqliteTable(streamId, path, { ...source, table: "missing" }));
    expect(missing).toEqual({ records: [], skipped: [], nextKey: null });
  }));

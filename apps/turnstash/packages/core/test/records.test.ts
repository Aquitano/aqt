import { expect, test } from "bun:test";

import { Schema } from "effect";

import {
  IngestBatch,
  IsoDate,
  IsoTimestamp,
  RecordKey,
  StreamId,
  WireRecord,
} from "../src/records.ts";
import { sqliteTableOf, streamIdOf, streamPartsOf } from "../src/source.ts";

test("source identity separates roots and storage kinds but preserves the relative path", () => {
  const source = {
    kind: "jsonl" as const,
    root: { path: "/root-a", label: "a" },
    relativePath: "projects/session.jsonl",
  };
  expect(streamIdOf(source)).not.toBe(
    streamIdOf({ ...source, root: { path: "/root-b", label: "a" } }),
  );
  expect(streamIdOf(source)).not.toBe(streamIdOf({ ...source, kind: "json" }));
  expect(streamIdOf(source)).toBe(
    streamIdOf({ ...source, root: { path: "/root-a/", label: "renamed" } }),
  );
  expect(streamIdOf(source)).toEndWith("/projects/session.jsonl");
  expect(streamPartsOf(streamIdOf(source))).toEqual({
    kind: "jsonl",
    relativePath: "projects/session.jsonl",
  });
});

test("stream parsing preserves nested paths and decodes SQLite table names", () => {
  const stream = streamPartsOf(
    streamIdOf({
      kind: "sqlite",
      root: { path: "/root", label: "root" },
      relativePath: "nested/path#with-hash.db",
      table: "table/with#symbols",
      keyColumn: "id",
    }),
  );
  expect(stream?.relativePath).toBe("nested/path#with-hash.db#table%2Fwith%23symbols");
  expect(sqliteTableOf(stream)).toBe("table/with#symbols");
  expect(sqliteTableOf(streamPartsOf("root/sqlite/store.db#bad%escape"))).toBe("bad%escape");
  expect(sqliteTableOf(streamPartsOf("root/jsonl/file#name.jsonl"))).toBeUndefined();
  expect(streamPartsOf("legacy-path.jsonl")).toBeUndefined();
});

test("wire schemas reject impossible timestamps and oversized batches", () => {
  const record = {
    provider: "claude",
    streamId: StreamId.make("s"),
    recordKey: RecordKey.make("0"),
    contentHash: "a".repeat(64),
    payload: "{}",
    observedAt: "2026-09-21T00:00:00Z",
    redactions: 0,
  };
  expect(Schema.is(WireRecord)(record)).toBe(true);
  for (const patch of [{ observedAt: "yesterday" }, { observedAt: "2026-02-30T00:00:00Z" }]) {
    expect(Schema.is(WireRecord)({ ...record, ...patch })).toBe(false);
  }
  const batch = {
    batchId: "f3783344-cfdf-45ab-883c-2e132330150a",
    machineId: "d4aa4082-eaf3-4de6-acb0-23985c26d539",
    agentVersion: "1",
    records: [record],
  };
  expect(Schema.is(IngestBatch)(batch)).toBe(true);
  expect(
    Schema.is(IngestBatch)({
      ...batch,
      records: [{ ...record, payload: "😀".repeat(2 * 1024 * 1024) }],
    }),
  ).toBe(false);
  expect(Schema.is(IsoTimestamp)("2026-09-21T12:00:00.123Z")).toBe(true);
  expect(Schema.is(IsoDate)("2026-02-30")).toBe(false);
});

import { Schema } from "effect";
import { expect, test } from "vite-plus/test";

import {
  ConversationCursor,
  ConversationListQuery,
  ExportSelection,
  MessageCursor,
  MessageQuery,
  SearchQuery,
  StatsFilter,
} from "../src/schemas.ts";

test("query schemas coerce strings and keep date bounds inside the PostgreSQL range", () => {
  const query = Schema.toCodecStringTree(ConversationListQuery);
  expect(Schema.decodeUnknownSync(query)({ limit: "20", from: "2026-09-01" })).toEqual({
    limit: 20,
    from: "2026-09-01",
  });
  expect(Schema.is(StatsFilter)({ to: "9998-12-31" })).toBe(true);
  expect(Schema.is(StatsFilter)({ to: "9999-12-31" })).toBe(false);
  expect(Schema.is(StatsFilter)({ projectKey: "a\u0000b" })).toBe(false);
  expect(Schema.is(ExportSelection)({ kind: "messages", messageKeys: ["a\u0000b"] })).toBe(false);
  expect(Schema.is(StatsFilter)({ timeZone: "Europe/Berlin" })).toBe(true);
  expect(Schema.is(StatsFilter)({ timeZone: "UTC" })).toBe(true);
  expect(Schema.is(StatsFilter)({ timeZone: "invalid/time-zone" })).toBe(false);
  expect(Schema.is(StatsFilter)({ timeZone: "+02:00" })).toBe(false);
});

test("rejects invalid pagination and unsupported search input", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  expect(Schema.is(ConversationCursor)(`0|${id}`)).toBe(true);
  for (const cursor of ["junk", "0|junk", `NaN|${id}`, `1e100|${id}`, `0|${id}|extra`]) {
    expect(Schema.is(ConversationCursor)(cursor)).toBe(false);
  }
  expect(Schema.is(MessageCursor)("0")).toBe(true);
  for (const cursor of ["", "-1", "1.5", "NaN", "Infinity", "2147483648"]) {
    expect(Schema.is(MessageCursor)(cursor)).toBe(false);
  }
  for (const q of [
    "",
    " ",
    "a\u0000b",
    "a".repeat(1025),
    "*",
    "text:*",
    "(*)",
    "a OR *",
    '*"text',
    "error*",
  ]) {
    expect(Schema.is(SearchQuery)({ q })).toBe(false);
  }
});

test("message seek queries validate stable keys and mutually exclusive pagination", () => {
  const decode = Schema.decodeUnknownSync(Schema.toCodecStringTree(MessageQuery));
  expect(decode({ message: "message / &?#", limit: "6" })).toEqual({
    message: "message / &?#",
    limit: 6,
  });
  expect(decode({ before: "0" })).toEqual({ before: "0" });
  for (const query of [
    { message: "" },
    { message: "nul\u0000key" },
    { message: "x".repeat(4097) },
    { message: "key", cursor: "0" },
    { cursor: "1", before: "2" },
    { before: "-1" },
  ]) {
    expect(() => decode(query)).toThrow();
  }
  expect(Schema.is(SearchQuery)({ q: "word", projectKey: "project / &?#", role: "tool" })).toBe(
    true,
  );
  expect(Schema.is(SearchQuery)({ q: "word", role: "admin" })).toBe(false);
});

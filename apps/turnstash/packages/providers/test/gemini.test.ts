import { expect, test } from "bun:test";
import { join } from "node:path";

import { RecordKey, streamIdOf, type SourceRecordRow, type SourceRoot } from "@aqt/turnstash-core";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Option } from "effect";

import { geminiNormalizer } from "../src/gemini/normalize.ts";
import { geminiSource } from "../src/gemini/source.ts";
import { jsonlRows } from "./support.ts";

const fixtures = join(import.meta.dir, "fixtures/gemini/tmp");
const observedAt = "2026-05-17T00:00:00.000Z";
const alphaPath = "3f2a9c1d/chats/session-alpha.json";
const betaPath = "7b41d0e2/chats/session-beta.jsonl";

const read = (relativePath: string) => Bun.file(join(fixtures, relativePath)).text();

const rootOf = (path: string): SourceRoot => ({ path, label: "tmp" });

const jsonRecords = (
  home: string,
  relativePath: string,
  payload: string,
): ReadonlyArray<SourceRecordRow> => [
  {
    streamId: streamIdOf({ kind: "json", root: rootOf(`${home}/.gemini/tmp`), relativePath }),
    recordKey: RecordKey.make("0"),
    payload,
    observedAt,
  },
];

const jsonlRecords = (
  home: string,
  relativePath: string,
  text: string,
): ReadonlyArray<SourceRecordRow> =>
  jsonlRows(
    streamIdOf({ kind: "jsonl", root: rootOf(`${home}/.gemini/tmp`), relativePath }),
    text,
    observedAt,
  );

const streamOf = (records: ReadonlyArray<SourceRecordRow>) => {
  const first = records[0];
  if (first === undefined) throw new Error("expected records");
  return first.streamId;
};

const normalized = (key: string, records: ReadonlyArray<SourceRecordRow>) => {
  const conversation = geminiNormalizer.normalize(key, records);
  if (conversation === null) throw new Error(`expected a conversation for ${key}`);
  return conversation;
};

const alpha = async () =>
  normalized("session-alpha-0001", jsonRecords("/Users/a", alphaPath, await read(alphaPath)));
const beta = async () =>
  normalized(betaPath, jsonlRecords("/Users/a", betaPath, await read(betaPath)));

test("roots put env overrides before the per-OS default", () => {
  expect(geminiSource.roots({ os: "darwin", home: "/Users/t", env: {} })).toEqual([
    { path: "/Users/t/.gemini/tmp", label: "tmp" },
  ]);
  expect(geminiSource.roots({ os: "win32", home: "C:\\Users\\t", env: {} })).toEqual([
    { path: "C:\\Users\\t\\.gemini\\tmp", label: "tmp" },
  ]);
  expect(
    geminiSource
      .roots({
        os: "linux",
        home: "/home/t",
        env: { GEMINI_SESSIONS_DIR: "/data/chats", GEMINI_DIR: "/data/gemini" },
      })
      .map((root) => root.path),
  ).toEqual(["/data/chats", "/data/gemini/tmp", "/home/t/.gemini/tmp"]);
});

test("discovery takes session files under each project's chats and types them by content", async () => {
  const descriptors = await Effect.runPromise(
    geminiSource.discover(rootOf(fixtures)).pipe(Effect.provide(BunServices.layer)),
  );
  expect(descriptors.map((descriptor) => [descriptor.relativePath, descriptor.kind])).toEqual([
    [alphaPath, "json"],
    ["3f2a9c1d/chats/session-delta.jsonl", "json"],
    [betaPath, "jsonl"],
  ]);
});

test("conversation keys use sessionId for whole files and the file path for JSONL lines", async () => {
  const lines = (await read(betaPath)).split("\n");
  const jsonStream = streamIdOf({
    kind: "json",
    root: rootOf("/Users/a/.gemini/tmp"),
    relativePath: alphaPath,
  });
  const jsonlStream = streamIdOf({
    kind: "jsonl",
    root: rootOf("/Users/a/.gemini/tmp"),
    relativePath: betaPath,
  });
  const keyOf = (streamId: typeof jsonStream, payload: string) =>
    Option.getOrUndefined(geminiNormalizer.conversationKeyOf(streamId, payload));

  expect(keyOf(jsonStream, await read(alphaPath))).toBe("session-alpha-0001");
  expect(keyOf(jsonlStream, lines[0] ?? "")).toBe(betaPath);
  expect(keyOf(jsonlStream, lines[2] ?? "")).toBe(betaPath);
  expect(Option.isNone(geminiNormalizer.conversationKeyOf(jsonlStream, "not json"))).toBe(true);
});

test("a whole-file session becomes ordered messages with the gemini ordinal fallback", async () => {
  const conversation = await alpha();
  expect(
    conversation.messages.map((message) => [message.messageKey, message.role, message.seq]),
  ).toEqual([
    ["u1", "user", 0],
    ["g1", "assistant", 1],
    ["u2", "user", 2],
    ["g2", "assistant", 3],
    ["idx-2", "assistant", 4],
    ["i1", "system", 5],
  ]);
  expect(conversation.title).toBe("add a retry to the fetch helper");
  expect(conversation.projectPath).toBe("3f2a9c1d");
  expect(conversation.startedAt).toBe("2026-05-16T10:00:00.000Z");
  expect(conversation.endedAt).toBe("2026-05-16T10:01:10.000Z");
});

test("message parts keep text, thoughts and tool calls, and array content is text too", async () => {
  const conversation = await alpha();
  const assistant = conversation.messages[1];
  expect(assistant?.parts).toEqual([
    { type: "text", text: "Reading the helper first." },
    { type: "thinking", text: "Plan\nRead the helper, then patch it." },
    { type: "tool_call", toolKey: "t1", name: "Read", input: { path: "src/fetch.ts" } },
    { type: "opaque", kind: "gemini_tool_prompt_tokens", data: 4 },
  ]);
  expect(assistant?.text).toBe(
    "Reading the helper first.\nPlan\nRead the helper, then patch it.\nRead",
  );
  expect(conversation.messages[2]?.parts).toEqual([
    { type: "text", text: "three attempts is enough" },
  ]);
});

test("tool executions pair with their call and stay open ended in both name casings", async () => {
  const conversation = await alpha();
  expect(conversation.toolExecutions).toEqual([
    {
      toolKey: "t1",
      messageKey: "g1",
      name: "Read",
      input: { path: "src/fetch.ts" },
      output: null,
      status: "ok",
      startedAt: "2026-05-16T10:00:05.000Z",
    },
    {
      toolKey: "t2",
      messageKey: "g2",
      name: "Bash",
      input: { command: "bun test" },
      output: null,
      status: "error",
      startedAt: "2026-05-16T10:01:05.000Z",
    },
  ]);
  expect((await beta()).toolExecutions.map((tool) => tool.name)).toEqual(["Read", "Bash"]);
});

test("a tool named after an Object.prototype member keeps its own name", async () => {
  const text = (await read(alphaPath)).replace('"name": "read_file"', '"name": "toString"');
  const conversation = normalized("session-alpha-0001", jsonRecords("/Users/a", alphaPath, text));
  expect(conversation.toolExecutions[0]?.name).toBe("toString");
});

test("usage subtracts cached input and bills thoughts as output", async () => {
  const conversation = await alpha();
  expect(conversation.requests.map((request) => request.requestKey)).toEqual(["g1", "g2", "idx-2"]);
  expect(conversation.requests[0]).toEqual({
    requestKey: "g1",
    messageKey: "g1",
    modelRaw: "gemini-3.1-pro-preview",
    requestedAt: "2026-05-16T10:00:05.000Z",
    usage: {
      inputTokens: 100,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 35,
      reasoningTokens: 5,
    },
    usageBasis: "reported",
    sourceRecordKey: "0",
  });
  expect((await beta()).requests[0]?.usage).toEqual({
    inputTokens: 150,
    cacheReadTokens: 50,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 52,
    reasoningTokens: 12,
  });
});

test("a JSONL session folds $set into metadata and bills only complete gemini turns", async () => {
  const conversation = await beta();
  expect(conversation.conversationKey).toBe(betaPath);
  expect(conversation.messages.map((message) => message.messageKey)).toEqual([
    "u1",
    "g1",
    "g2",
    "g3",
    "g4",
  ]);
  expect(conversation.requests.map((request) => request.requestKey)).toEqual(["g1"]);
  expect(conversation.messages[2]?.createdAt).toBe("2026-05-16T11:00:00.000Z");
  expect(conversation.startedAt).toBe("2026-05-16T11:00:00.000Z");
  expect(conversation.endedAt).toBe("2026-05-16T11:02:00.000Z");
});

test("the same session from two machines and in any record order normalizes once", async () => {
  const text = await read(betaPath);
  const one = jsonlRecords("/Users/a", betaPath, text);
  const two = jsonlRecords("/home/b", betaPath, text);
  const shuffled = [...two, ...one].reverse();
  expect(geminiNormalizer.conversationKeyOf(streamOf(one), text)).toEqual(
    geminiNormalizer.conversationKeyOf(streamOf(two), text),
  );
  expect(normalized(betaPath, shuffled)).toEqual(await beta());
});

test("a re-appended message keeps its updated tools and usage exactly once", () => {
  const first = {
    id: "g1",
    timestamp: "2026-05-16T11:00:20.000Z",
    type: "gemini",
    content: "Reading the file.",
    model: "gemini-2.5-pro",
    tokens: { input: 100, output: 10 },
  };
  const last = {
    ...first,
    tokens: { input: 120, output: 20 },
    toolCalls: [{ id: "t1", name: "ReadFile", args: { path: "README.md" }, status: "success" }],
  };
  const text = [first, last].map((value) => JSON.stringify(value)).join("\n");
  const records = jsonlRecords("/Users/a", betaPath, text);
  for (const ordered of [records, [...records].reverse()]) {
    const conversation = normalized(betaPath, ordered);
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.toolExecutions.map((tool) => [tool.toolKey, tool.name])).toEqual([
      ["t1", "Read"],
    ]);
    expect(conversation.requests).toHaveLength(1);
    expect(conversation.requests[0]?.usage).toMatchObject({ inputTokens: 120, outputTokens: 20 });
    expect(conversation.requests[0]?.sourceRecordKey).toBe(records[1]?.recordKey);
  }
});

test("a corrected timestamp from another machine revives a dropped request", async () => {
  const text = await read(betaPath);
  const corrected = text.replace(
    '"timestamp":"1999-01-01T00:00:00.000Z"',
    '"timestamp":"2026-05-16T11:01:45.000Z"',
  );
  const conversation = normalized(betaPath, [
    ...jsonlRecords("/Users/a", betaPath, text),
    ...jsonlRecords("/home/b", betaPath, corrected),
  ]);
  expect(conversation.messages.map((message) => message.messageKey)).toEqual([
    "u1",
    "g1",
    "g2",
    "g3",
    "g4",
  ]);
  expect(conversation.requests.map((request) => request.requestKey)).toEqual(["g1", "g2"]);
  expect(conversation.messages[2]?.createdAt).toBe("2026-05-16T11:01:45.000Z");
});

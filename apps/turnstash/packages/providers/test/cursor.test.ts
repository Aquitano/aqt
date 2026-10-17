import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RecordKey, StreamId, type HostEnv, type SourceRecordRow } from "@aqt/turnstash-core";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Option } from "effect";

import { cursorNormalizer, cursorSource } from "../src/cursor/index.ts";
import fixture from "./fixtures/cursor/conversation.json";
import { canonical } from "./support.ts";

const composerId = fixture.composerId;
const bubbleKey = (bubbleId: string): string => `bubbleId:${composerId}:${bubbleId}`;

const userA = "44444444-4444-4444-8444-444444444444";
const assistantA = "22222222-2222-4222-8222-222222222222";
const userB = "66666666-6666-4666-8666-666666666666";
const thinkingB = "77777777-7777-4777-8777-777777777777";
const toolB = "33333333-3333-4333-8333-333333333333";
const assistantB = "55555555-5555-4555-8555-555555555555";

const rowPayload = (key: string, value: unknown, blob = false): string => {
  const text = JSON.stringify(value);
  return canonical({ key, value: blob ? Buffer.from(text).toString("base64") : text });
};

const record = (
  streamId: string,
  recordKey: string,
  payload: string,
  observedAt: string,
): SourceRecordRow => ({
  streamId: StreamId.make(streamId),
  recordKey: RecordKey.make(recordKey),
  payload,
  observedAt,
});

const diskKvStream = "machine-a/sqlite/state.vscdb#cursorDiskKV";
const headerStream = "machine-a/sqlite/state.vscdb#composerHeaders";

const diskKvRecords = (
  streamId = diskKvStream,
  observedAt = "2026-09-20T10:00:00.000Z",
): ReadonlyArray<SourceRecordRow> =>
  fixture.diskKv.map((entry) =>
    record(streamId, entry.key, rowPayload(entry.key, entry.value, entry.blob), observedAt),
  );

const headerRecords = (
  streamId = headerStream,
  observedAt = "2026-09-20T10:00:00.000Z",
): ReadonlyArray<SourceRecordRow> =>
  fixture.composerHeaders.map((entry) =>
    record(
      streamId,
      entry.composerId,
      canonical({ ...entry, value: JSON.stringify(entry.value) }),
      observedAt,
    ),
  );

const allRecords = (): ReadonlyArray<SourceRecordRow> => [...diskKvRecords(), ...headerRecords()];

const normalized = (records: ReadonlyArray<SourceRecordRow>) => {
  const conversation = cursorNormalizer.normalize(composerId, records);
  if (conversation === null) throw new Error("expected a conversation");
  return conversation;
};

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

const host = (os: HostEnv["os"], home: string, env: HostEnv["env"] = {}): HostEnv => ({
  os,
  home,
  env,
});

test("roots cover both Cursor installs per OS and the database override", () => {
  expect(cursorSource.roots(host("darwin", "/Users/dev")).map((root) => root.path)).toEqual([
    "/Users/dev/Library/Application Support/Cursor/User/globalStorage",
    "/Users/dev/Library/Application Support/Cursor Nightly/User/globalStorage",
  ]);
  expect(cursorSource.roots(host("linux", "/home/dev"))[0]?.path).toBe(
    "/home/dev/.config/Cursor/User/globalStorage",
  );
  expect(
    cursorSource.roots(
      host("win32", "C:\\Users\\dev", { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" }),
    )[0]?.path,
  ).toBe("C:\\Users\\dev\\AppData\\Roaming\\Cursor\\User\\globalStorage");
  expect(
    cursorSource.roots(
      host("darwin", "/Users/dev", {
        TURNSTASH_CURSOR_DB: "/tmp/fixture/globalStorage/state.vscdb",
      }),
    )[0],
  ).toEqual({ path: "/tmp/fixture/globalStorage", label: "TURNSTASH_CURSOR_DB" });
});

const discover = (path: string) =>
  Effect.runPromise(
    cursorSource.discover({ path, label: "test" }).pipe(Effect.provide(BunServices.layer)),
  );

test("discovery yields both table streams and nothing without the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turnstash-cursor-"));
  try {
    await Bun.write(join(directory, "state.vscdb"), "SQLite format 3\u0000");
    const descriptors = await discover(directory);
    expect(
      descriptors.map((descriptor) => descriptor.kind === "sqlite" && descriptor.table),
    ).toEqual(["cursorDiskKV", "composerHeaders"]);
    const [diskKv] = descriptors;
    expect(diskKv).toEqual({
      kind: "sqlite",
      root: { path: directory, label: "test" },
      relativePath: "state.vscdb",
      table: "cursorDiskKV",
      keyColumn: "key",
      where:
        "(key >= 'bubbleId:' AND key < 'bubbleId;') OR (key >= 'composerData:' AND key < 'composerData;')",
    });
    expect(await discover(join(directory, "missing"))).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const conversationKey = (payload: string) =>
  Option.getOrUndefined(cursorNormalizer.conversationKeyOf(StreamId.make(diskKvStream), payload));

test("conversation keys come from the row key and skip tool-call sub-composers", () => {
  expect(conversationKey(rowPayload(bubbleKey(userA), { type: 1 }))).toBe(composerId);
  expect(conversationKey(rowPayload(`composerData:${composerId}`, { composerId }))).toBe(
    composerId,
  );
  expect(
    conversationKey(rowPayload("bubbleId:task-call_x\nfc_y:aaaa", { type: 2 })),
  ).toBeUndefined();
  expect(conversationKey(rowPayload(`checkpointId:${composerId}:cp-1`, {}))).toBeUndefined();
  expect(conversationKey(canonical({ composerId, recency: 1747141000000, value: "{}" }))).toBe(
    composerId,
  );
  expect(conversationKey("not json")).toBeUndefined();
});

test("bubbles become messages in the order the composer header list records", () => {
  const conversation = normalized(allRecords());
  expect(conversation.messages.map((message) => message.messageKey)).toEqual([
    userA,
    assistantA,
    userB,
    thinkingB,
    toolB,
    assistantB,
  ]);
  expect(conversation.messages.map((message) => message.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(conversation.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
    "assistant",
    "assistant",
  ]);
  expect(conversation.title).toBe("Tidy the parser entry point");
  expect(conversation.projectPath).toBe("/Users/dev/projects/parser");
  expect(conversation.startedAt).toBe(iso(1747131011000));
  expect(conversation.endedAt).toBe(iso(1747141000000));
});

test("parts carry text, flattened rich text, thinking and code blocks", () => {
  const conversation = normalized(allRecords());
  const [first, second, third, fourth] = conversation.messages;
  expect(first?.parts).toEqual([{ type: "text", text: "Rename the parser entry point" }]);
  expect(first?.createdAt).toBe(iso(1747131012000));
  expect(second?.parts).toEqual([
    { type: "text", text: "Renamed it to parseEntry." },
    { type: "opaque", kind: "cursor_code_block", data: { languageId: "typescript" } },
  ]);
  expect(third?.parts).toEqual([{ type: "text", text: "Now add a test." }]);
  expect(third?.createdAt).toBe(iso(1747131011000));
  expect(fourth?.parts).toEqual([{ type: "thinking", text: "Check the fixtures first." }]);
  expect(fourth?.text).toBe("Check the fixtures first.");
});

test("a tool bubble stored as a BLOB pairs its call with its result", () => {
  const conversation = normalized(allRecords());
  const message = conversation.messages[4];
  expect(message?.parts).toEqual([
    {
      type: "tool_call",
      toolKey: "toolu_0001",
      name: "edit_file",
      input: { target_file: "src/parser.test.ts", instructions: "add a focused case" },
    },
    {
      type: "tool_result",
      toolKey: "toolu_0001",
      output: '{"diff":"+ test(\'parses the entry point\', () => {})"}',
      isError: false,
    },
    {
      type: "opaque",
      kind: "cursor_tool_decision",
      data: { toolKey: "toolu_0001", decision: "accepted" },
    },
  ]);
  expect(message?.text).toBe("");
  expect(conversation.toolExecutions).toEqual([
    {
      toolKey: "toolu_0001",
      messageKey: toolB,
      name: "edit_file",
      input: { target_file: "src/parser.test.ts", instructions: "add a focused case" },
      output: '{"diff":"+ test(\'parses the entry point\', () => {})"}',
      status: "ok",
    },
  ]);
});

test("prototype names remain tool names instead of resolving to inherited object members", () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    const key = bubbleKey(toolB);
    const records = allRecords().filter((entry) => String(entry.recordKey) !== key);
    records.push(
      record(
        diskKvStream,
        key,
        rowPayload(key, {
          type: 2,
          toolFormerData: { name, toolCallId: "prototype-tool", rawArgs: "{}" },
        }),
        "2026-09-20T10:00:00.000Z",
      ),
    );
    const conversation = normalized(records);
    expect(
      conversation.toolExecutions.find((tool) => tool.toolKey === "prototype-tool")?.name,
    ).toBe(name);
    expect(
      conversation.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool_call" && part.toolKey === "prototype-tool"),
    ).toMatchObject({ name });
  }
});

test("a turn with reported bubble tokens becomes one request", () => {
  const request = normalized(allRecords()).requests[0];
  expect(request).toEqual({
    requestKey: "request:req-aaaa",
    messageKey: assistantA,
    modelRaw: "gpt-5",
    requestedAt: iso(1747131012000),
    usage: {
      inputTokens: 1200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 340,
      reasoningTokens: 0,
    },
    usageBasis: "reported",
    sourceRecordKey: bubbleKey(assistantA),
  });
});

test("a zero-token turn is estimated from the visible characters", () => {
  const conversation = normalized(allRecords());
  expect(conversation.requests).toHaveLength(2);
  const request = conversation.requests[1];
  expect(request?.requestKey).toBe("usage:usage-bbbb");
  expect(request?.usageBasis).toBe("estimated");
  expect(request?.usage.inputTokens).toBe(4);
  expect(request?.usage.outputTokens).toBe(6);
  expect(request?.requestedAt).toBe(iso(1747131011000));
});

test("the same conversation seen from two machines counts once and keeps the settled tokens", () => {
  const single = normalized(allRecords());
  const mirrored = [
    ...allRecords(),
    ...diskKvRecords("machine-b/sqlite/state.vscdb#cursorDiskKV", "2026-09-20T11:00:00.000Z"),
    ...headerRecords("machine-b/sqlite/state.vscdb#composerHeaders", "2026-09-20T11:00:00.000Z"),
  ];
  expect(normalized(mirrored)).toEqual(single);

  const settled = record(
    "machine-b/sqlite/state.vscdb#cursorDiskKV",
    bubbleKey(assistantA),
    rowPayload(bubbleKey(assistantA), {
      _v: 2,
      type: 2,
      text: "Renamed it to parseEntry.",
      requestId: "req-aaaa",
      tokenCount: { inputTokens: 0, outputTokens: 500 },
      timingInfo: { clientRpcSendTime: 1747131014000, clientSettleTime: 1747131015500 },
    }),
    "2026-09-20T12:00:00.000Z",
  );
  const later = normalized([...allRecords(), settled]);
  expect(later.messages).toHaveLength(single.messages.length);
  expect(later.requests[0]?.usage.outputTokens).toBe(500);
});

test("records without a bubble do not form a conversation", () => {
  const metadata = allRecords().filter(
    (row) => row.recordKey.startsWith("composerData:") || row.recordKey === composerId,
  );
  expect(metadata).toHaveLength(2);
  expect(cursorNormalizer.normalize(composerId, metadata)).toBeNull();
  expect(cursorNormalizer.normalize(composerId, [])).toBeNull();
});

test("without a composer row the model falls back to the auto label and time orders the bubbles", () => {
  const bubbles = diskKvRecords().filter(
    (row) => row.recordKey === bubbleKey(userA) || row.recordKey === bubbleKey(assistantA),
  );
  const conversation = normalized(bubbles.toReversed());
  expect(conversation.messages.map((message) => message.messageKey)).toEqual([userA, assistantA]);
  expect(conversation.title).toBe("Rename the parser entry point");
  expect(conversation.projectPath).toBeUndefined();
  expect(conversation.startedAt).toBe(iso(1747131012000));
  expect(conversation.requests.map((request) => request.modelRaw)).toEqual(["cursor-auto"]);
});

test("bubbles without timing fall back to when the agent saw them", () => {
  const conversation = normalized(
    diskKvRecords().filter((row) => row.recordKey === bubbleKey(userB)),
  );
  expect(conversation.startedAt).toBe("2026-09-20T10:00:00.000Z");
  expect(conversation.messages.map((message) => message.createdAt)).toEqual([
    "2026-09-20T10:00:00.000Z",
  ]);
});

const competing = (streamId: string, text: string) =>
  record(
    streamId,
    bubbleKey(userA),
    rowPayload(bubbleKey(userA), { _v: 2, type: 1, text }),
    "2026-09-20T10:00:00.000Z",
  );

test("trimming keeps JSON values as values and leaves the conversation unchanged", () => {
  const records = [
    ...allRecords().filter((row) => row.recordKey !== bubbleKey(userA)),
    competing(diskKvStream, "a"),
    competing("machine-b/sqlite/state.vscdb#cursorDiskKV", "aB"),
  ];
  const trimmed = records.map((row) => ({
    ...row,
    payload: cursorNormalizer.trim?.(row.streamId, row.payload) ?? row.payload,
  }));
  expect(normalized(trimmed)).toEqual(normalized(records));
  expect(trimmed.some((row) => row.payload.includes('"value":{'))).toBe(true);
});

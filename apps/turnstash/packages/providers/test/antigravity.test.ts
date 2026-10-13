import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RecordKey,
  sha256Hex,
  type SourceRecordRow,
  StreamId,
  streamIdOf,
} from "@aqt/turnstash-core";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Option } from "effect";

import { antigravityNormalizer, antigravitySource } from "../src/antigravity/index.ts";
import { timestampOf } from "../src/antigravity/proto.ts";

const varint = (value: number): Array<number> => {
  const bytes: Array<number> = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return bytes;
};
const num = (field: number, value: number) => [...varint((field << 3) | 0), ...varint(value)];
const bytes = (field: number, payload: ReadonlyArray<number>) => [
  ...varint((field << 3) | 2),
  ...varint(payload.length),
  ...payload,
];
const str = (field: number, value: string) => bytes(field, [...new TextEncoder().encode(value)]);

const usageRow = (input: {
  idx: number;
  steps: ReadonlyArray<number>;
  inputTokens: number;
  outputTokens: number;
  response?: number;
  thinking: number;
  responseId: string;
  seconds: number;
  raw: string;
  display: string;
}) => {
  const usage = [
    ...num(2, input.inputTokens),
    ...num(3, input.outputTokens),
    ...num(9, input.response ?? 0),
    ...num(10, input.thinking),
    ...str(11, input.responseId),
  ];
  const created = bytes(4, num(1, input.seconds));
  const chat = [
    ...bytes(4, usage),
    ...bytes(9, created),
    ...str(19, input.raw),
    ...str(21, input.display),
  ];
  const root = [...bytes(1, chat), ...bytes(2, input.steps.flatMap(varint))];
  return JSON.stringify({
    data: Buffer.from(root).toString("base64"),
    idx: input.idx,
    size: root.length,
  });
};

const root = { path: "/home/dev/.gemini/antigravity-cli", label: "antigravity-cli" };
const usageStream = streamIdOf({
  kind: "sqlite",
  root,
  relativePath: "conversations/cascade-1.db",
  table: "gen_metadata",
  keyColumn: "idx",
});
const transcriptStream = streamIdOf({
  kind: "jsonl",
  root,
  relativePath: "brain/cascade-1/.system_generated/logs/transcript_full.jsonl",
});

const transcript = [
  {
    step_index: 0,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    created_at: "2026-09-21T09:00:00Z",
    content: "<USER_REQUEST>add a login page</USER_REQUEST>",
  },
  {
    step_index: 1,
    source: "SYSTEM",
    type: "GENERIC",
    status: "DONE",
    created_at: "2026-09-21T09:00:00Z",
    content:
      "You have read and write access to the following workspace(s):\n- file:///Users/dev/proj%20x\n",
  },
  {
    step_index: 2,
    source: "MODEL",
    type: "RUN_COMMAND",
    status: "ERROR",
    created_at: "2026-09-21T09:00:05Z",
    content: "Created At: 09:00\nOutput:\nok",
  },
  {
    step_index: 3,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-09-21T09:00:08Z",
    content: "Done, the page exists.",
    thinking: "plan first",
  },
];

const row = (
  streamId: StreamId,
  recordKey: string,
  payload: string,
  observedAt = "2026-09-21T10:00:00.000Z",
): SourceRecordRow => ({
  streamId,
  recordKey: RecordKey.make(recordKey),
  payload,
  observedAt,
});

const records = (): Array<SourceRecordRow> => [
  ...transcript.map((step, index) =>
    row(transcriptStream, String(index * 100), JSON.stringify(step)),
  ),
  row(
    usageStream,
    "0",
    usageRow({
      idx: 0,
      steps: [2, 3],
      inputTokens: 18124,
      outputTokens: 192,
      thinking: 47,
      responseId: "resp-1",
      seconds: 1_789_000_000,
      raw: "gemini-3-flash-agent",
      display: "Gemini 3.5 Flash (High)",
    }),
  ),
  row(
    usageStream,
    "1",
    usageRow({
      idx: 1,
      steps: [9],
      inputTokens: 100,
      outputTokens: 0,
      response: 7,
      thinking: 3,
      responseId: "resp-2",
      seconds: 1_789_000_010,
      raw: "MODEL_PLACEHOLDER_1",
      display: "",
    }),
  ),
];

test("conversation keys derive from the database name and the brain directory", () => {
  expect(antigravityNormalizer.conversationKeyOf(usageStream, "")).toEqual(
    Option.some("cascade-1"),
  );
  expect(antigravityNormalizer.conversationKeyOf(transcriptStream, "")).toEqual(
    Option.some("cascade-1"),
  );
  expect(
    antigravityNormalizer.conversationKeyOf(
      StreamId.make(`${sha256Hex("x")}/jsonl/other.jsonl`),
      "",
    ),
  ).toEqual(Option.none());
});

test("transcript steps become messages and tools, usage rows become requests linked to their answer", () => {
  const conversation = antigravityNormalizer.normalize("cascade-1", records());
  if (conversation === null) throw new Error("expected a conversation");
  expect(conversation.title).toBe("add a login page");
  expect(conversation.projectPath).toBe("/Users/dev/proj x");
  expect(
    conversation.messages.map((message) => [message.messageKey, message.role, message.seq]),
  ).toEqual([
    ["s0", "user", 0],
    ["s1", "assistant", 1],
    ["s1:result", "tool", 2],
    ["s2", "assistant", 3],
    ["s2:result", "tool", 4],
    ["s3", "assistant", 5],
  ]);
  expect(conversation.messages[5]?.parts).toEqual([
    { type: "thinking", text: "plan first" },
    { type: "text", text: "Done, the page exists." },
  ]);
  expect(conversation.toolExecutions[1]).toEqual({
    toolKey: "s2",
    messageKey: "s2",
    name: "run_command",
    input: {},
    output: "Created At: 09:00\nOutput:\nok",
    status: "error",
    startedAt: "2026-09-21T09:00:05.000Z",
  });
  expect(conversation.requests).toEqual([
    {
      requestKey: "resp-1",
      messageKey: "s3",
      modelRaw: "gemini-3.5-flash-high",
      requestedAt: "2026-09-10T00:26:40.000Z",
      usage: {
        inputTokens: 18124,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 192,
        reasoningTokens: 47,
      },
      usageBasis: "reported",
    },
    {
      requestKey: "resp-2",
      modelRaw: "unknown",
      requestedAt: "2026-09-10T00:26:50.000Z",
      usage: {
        inputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 10,
        reasoningTokens: 3,
      },
      usageBasis: "reported",
    },
  ]);
  expect(conversation.startedAt).toBe("2026-09-10T00:26:40.000Z");
});

test("a timestamp past the Date range yields none instead of throwing", () => {
  const millis = 8_700_000_000_000_000;
  expect(
    timestampOf({ number: 4, wireType: 2, bytes: new Uint8Array(num(1, millis / 1000)) }),
  ).toBeUndefined();
  expect(timestampOf({ number: 4, wireType: 0, value: BigInt(millis) })).toBeUndefined();
});

test("the same rows seen from two machines and a shorter transcript copy do not duplicate anything", () => {
  const duplicate = records().map((record) => ({
    ...record,
    streamId: StreamId.make(record.streamId.replace(/^[a-f0-9]{64}/, sha256Hex("machine-b"))),
    observedAt: "2026-09-22T10:00:00.000Z",
  }));
  const truncated = { ...transcript[3], content: "Done" };
  const conversation = antigravityNormalizer.normalize("cascade-1", [
    ...records(),
    ...duplicate,
    row(transcriptStream, "999", JSON.stringify(truncated), "2026-09-23T00:00:00.000Z"),
  ]);
  expect(conversation).toEqual(antigravityNormalizer.normalize("cascade-1", records()));
});

test("discovery lists usage tables and the fullest transcript per conversation", async () => {
  const home = await mkdtemp(join(tmpdir(), "antigravity-"));
  try {
    const app = join(home, ".gemini", "antigravity-cli");
    await mkdir(join(app, "conversations"), { recursive: true });
    await mkdir(join(app, "brain", "a", ".system_generated", "logs"), { recursive: true });
    await mkdir(join(app, "brain", "b", ".system_generated", "logs"), { recursive: true });
    await writeFile(join(app, "conversations", "a.db"), "");
    await writeFile(join(app, "conversations", "a.db-wal"), "");
    await writeFile(join(app, "conversations", "b.db"), "");
    await writeFile(
      join(app, "brain", "a", ".system_generated", "logs", "transcript_full.jsonl"),
      "",
    );
    await writeFile(join(app, "brain", "a", ".system_generated", "logs", "transcript.jsonl"), "");
    await writeFile(join(app, "brain", "b", ".system_generated", "logs", "transcript.jsonl"), "");
    const testRoot = { path: app, label: "antigravity-cli" };
    const descriptors = await Effect.runPromise(
      antigravitySource.discover(testRoot).pipe(Effect.provide(BunServices.layer)),
    );
    expect(
      descriptors.map((descriptor) =>
        descriptor.kind === "sqlite"
          ? `${descriptor.relativePath}#${descriptor.table}`
          : descriptor.relativePath,
      ),
    ).toEqual([
      "conversations/a.db#gen_metadata",
      "brain/a/.system_generated/logs/transcript_full.jsonl",
      "conversations/b.db#gen_metadata",
      "brain/b/.system_generated/logs/transcript.jsonl",
    ]);
    expect(
      antigravitySource
        .roots({ os: "darwin", home: "/h", env: {} })
        .map((candidate) => candidate.path),
    ).toEqual([
      "/h/.gemini/antigravity-cli",
      "/h/.gemini/antigravity",
      "/h/.gemini/antigravity-ide",
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

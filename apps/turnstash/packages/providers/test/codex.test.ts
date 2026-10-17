import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NormalizedConversation,
  RecordKey,
  StreamId,
  type HostEnv,
  type HostOs,
  type SourceRecordRow,
} from "@aqt/turnstash-core";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Option, Schema } from "effect";

import { codexNormalizer, codexSource } from "../src/codex/index.ts";
import { jsonlRows } from "./support.ts";

const guardian =
  "sessions/2026/09/20/rollout-2026-09-20T10-58-17-00000000-0000-7000-0000-00000000bbbb.jsonl";
const legacy =
  "sessions/2026/09/19/rollout-2026-09-19T08-00-00-00000000-0000-7000-0000-0000000011aa.jsonl";

const rowsOf = async (
  fixture: string,
  machine = "machine-a",
  observedAt = "2026-09-21T00:00:00.000Z",
): Promise<ReadonlyArray<SourceRecordRow>> => {
  const text = await Bun.file(join(import.meta.dir, "fixtures", "codex", fixture)).text();
  return jsonlRows(StreamId.make(`${machine}/jsonl/${fixture}`), text, observedAt);
};

const normalized = (rows: ReadonlyArray<SourceRecordRow>) => {
  const first = rows[0];
  if (first === undefined) throw new Error("no records");
  const conversationKey = codexNormalizer.conversationKeyOf(first.streamId, first.payload);
  if (Option.isNone(conversationKey)) throw new Error("no conversation key");
  const conversation = codexNormalizer.normalize(conversationKey.value, rows);
  if (conversation === null) throw new Error("records did not form a conversation");
  if (!Schema.is(NormalizedConversation)(conversation))
    throw new Error("conversation is not schema valid");
  return conversation;
};

const host = (os: HostOs, home: string, env: Record<string, string | undefined> = {}): HostEnv => ({
  os,
  home,
  env,
});

test("roots put CODEX_HOME ahead of the home directory and collapse a duplicate", () => {
  expect(codexSource.roots(host("darwin", "/Users/u"))).toEqual([
    { path: "/Users/u/.codex", label: ".codex" },
  ]);
  expect(codexSource.roots(host("win32", "C:\\Users\\u"))).toEqual([
    { path: "C:\\Users\\u\\.codex", label: ".codex" },
  ]);
  expect(codexSource.roots(host("linux", "/home/u", { CODEX_HOME: "/srv/codex" }))).toEqual([
    { path: "/srv/codex", label: "CODEX_HOME" },
    { path: "/home/u/.codex", label: ".codex" },
  ]);
  expect(codexSource.roots(host("linux", "/home/u", { CODEX_HOME: "/home/u/.codex/" }))).toEqual([
    { path: "/home/u/.codex/", label: "CODEX_HOME" },
  ]);
});

test("discovery keeps rollouts with a session_meta head and prefers the live copy of a basename", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnstash-codex-"));
  try {
    for (const directory of [
      "sessions",
      "sessions/2026",
      "sessions/2026/09",
      "sessions/2026/09/20",
      "archived_sessions",
      "sessions/2026/09/notaday",
    ]) {
      await mkdir(join(root, directory));
    }
    const head = (payload: string) =>
      `{"timestamp":"2026-09-20T10:58:18.048Z","ordinal":0,"type":"session_meta","payload":${payload}}\n{"timestamp":"2026-09-20T10:58:19.000Z","ordinal":1,"type":"event_msg","payload":{}}\n`;
    const valid = head(`{"id":"00000000-0000-7000-0000-00000000bbbb"}`);
    await Bun.write(
      join(
        root,
        "sessions/2026/09/20/rollout-2026-09-20T10-58-17-00000000-0000-7000-0000-00000000bbbb.jsonl",
      ),
      valid,
    );
    await Bun.write(
      join(
        root,
        "archived_sessions/rollout-2026-09-20T10-58-17-00000000-0000-7000-0000-00000000bbbb.jsonl",
      ),
      valid,
    );
    await Bun.write(
      join(
        root,
        "archived_sessions/rollout-2026-09-18T09-00-00-00000000-0000-7000-0000-00000000cccc.jsonl",
      ),
      valid,
    );
    await Bun.write(
      join(
        root,
        "sessions/2026/09/20/rollout-2026-09-20T11-00-00-00000000-0000-7000-0000-00000000dddd.jsonl",
      ),
      head(`"scalar"`),
    );
    await Bun.write(
      join(
        root,
        "sessions/2026/09/20/rollout-2026-09-20T12-00-00-00000000-0000-7000-0000-00000000eeee.jsonl",
      ),
      `{"git":{},"id":"x","instructions":"pre-wrapper"}\n`,
    );
    await Bun.write(
      join(
        root,
        "sessions/2026/09/notaday/rollout-2026-09-20T13-00-00-00000000-0000-7000-0000-00000000ffff.jsonl",
      ),
      valid,
    );
    await Bun.write(join(root, "history.jsonl"), valid);

    const descriptors = await Effect.runPromise(
      codexSource.discover({ path: root, label: "test" }).pipe(Effect.provide(BunServices.layer)),
    );
    expect(descriptors).toEqual([
      {
        kind: "jsonl",
        root: { path: root, label: "test" },
        relativePath:
          "archived_sessions/rollout-2026-09-18T09-00-00-00000000-0000-7000-0000-00000000cccc.jsonl",
      },
      {
        kind: "jsonl",
        root: { path: root, label: "test" },
        relativePath:
          "sessions/2026/09/20/rollout-2026-09-20T10-58-17-00000000-0000-7000-0000-00000000bbbb.jsonl",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovery reads compressed rollouts under their uncompressed name, preferring an uncompressed copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnstash-codex-"));
  try {
    await mkdir(join(root, "sessions/2026/09/20"), { recursive: true });
    const rollout = (id: string) =>
      `sessions/2026/09/20/rollout-2026-09-20T10-58-17-00000000-0000-7000-0000-0000000${id}.jsonl`;
    const head = '{"type":"session_meta","payload":{}}\n';
    const compressed = Bun.zstdCompressSync(Buffer.from(head));
    await Bun.write(join(root, `${rollout("0aaaa")}.zst`), compressed);
    await Bun.write(join(root, `${rollout("0bbbb")}.zst`), compressed);
    await Bun.write(join(root, rollout("0bbbb")), head);

    const descriptors = await Effect.runPromise(
      codexSource.discover({ path: root, label: "test" }).pipe(Effect.provide(BunServices.layer)),
    );
    expect(descriptors).toEqual([
      {
        kind: "jsonl",
        root: { path: root, label: "test" },
        relativePath: rollout("0aaaa"),
        compression: "zstd",
      },
      { kind: "jsonl", root: { path: root, label: "test" }, relativePath: rollout("0bbbb") },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the conversation key is the filename uuid, whatever the record holds", () => {
  const key = codexNormalizer.conversationKeyOf(
    StreamId.make(`abc/jsonl/${guardian}`),
    `{"type":"session_meta","payload":{"id":"00000000-0000-7000-0000-00000000aaaa"}}`,
  );
  expect(Option.getOrNull(key)).toBe("00000000-0000-7000-0000-00000000bbbb");
  expect(
    Option.isNone(
      codexNormalizer.conversationKeyOf(StreamId.make("abc/jsonl/history.jsonl"), "{}"),
    ),
  ).toBe(true);
});

test("the first session_meta wins and the replayed parent one only supplies the parent link", async () => {
  const conversation = normalized(await rowsOf(guardian));
  expect(conversation.conversationKey).toBe("00000000-0000-7000-0000-00000000bbbb");
  expect(conversation.parentConversationKey).toBe("00000000-0000-7000-0000-00000000aaaa");
  expect(conversation.projectPath).toBe("/home/user/project");
  expect(conversation.gitBranch).toBe("main");
  expect(conversation.clientVersion).toBe("0.155.0");
  expect(conversation.startedAt).toBe("2026-09-20T10:58:18.048Z");
  expect(conversation.endedAt).toBe("2026-09-20T10:58:30.000Z");
});

test("messages carry roles, reasoning summaries and image metadata, and ignore item_completed", async () => {
  const conversation = normalized(await rowsOf(guardian));
  expect(conversation.messages.map((message) => [message.role, message.messageKey])).toEqual([
    ["user", "msg_00000000-0000-7000-0000-00000000eeee"],
    ["system", "msg_00000000-0000-7000-0000-00000000eeef"],
    ["assistant", "rs_0000000001"],
    ["assistant", "fc_0000000002"],
    ["tool", "fco_0000000004"],
    ["assistant", "ctc_0000000005"],
    ["tool", "ctco_0000000007"],
    ["assistant", "msg_00000000-0000-7000-0000-00000000ffff"],
    ["user", "msg_00000000-0000-7000-0000-000000010000"],
  ]);
  expect(conversation.messages.map((message) => message.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  expect(conversation.messages[2]?.parts).toEqual([
    { type: "thinking", text: "check the suite first" },
  ]);
  expect(conversation.messages[8]?.parts).toEqual([
    { type: "text", text: "here is the screenshot" },
    { type: "image", mediaType: "image/png", bytes: 8 },
  ]);
  expect(conversation.messages[8]?.text).toBe("here is the screenshot");
});

test("tool calls pair with their output and mcp calls keep the namespaced name", async () => {
  const conversation = normalized(await rowsOf(guardian));
  expect(conversation.toolExecutions).toEqual([
    {
      toolKey: "call_0000000003",
      messageKey: "fc_0000000002",
      name: "mcp__cua_repl__js",
      input: { code: "tools.exec_command('bun test')", title: "run tests" },
      output: "2 tests failed",
      status: "ok",
      startedAt: "2026-09-20T10:58:21.000Z",
      endedAt: "2026-09-20T10:58:21.100Z",
    },
    {
      toolKey: "call_0000000006",
      messageKey: "ctc_0000000005",
      name: "exec",
      input: "bun test packages/core",
      output: "ok",
      status: "ok",
      startedAt: "2026-09-20T10:58:21.200Z",
      endedAt: "2026-09-20T10:58:21.300Z",
    },
  ]);
  expect(conversation.messages[4]?.parts).toEqual([
    { type: "tool_result", toolKey: "call_0000000003", output: "2 tests failed", isError: false },
  ]);
});

test("a token_usage_record is the request and the token_count that follows it is ignored", async () => {
  const rows = await rowsOf(guardian);
  const conversation = normalized(rows);
  const usageRow = rows.find((row) => row.payload.includes(`"type":"token_usage_record"`));
  if (usageRow === undefined) throw new Error("fixture has no token_usage_record");
  expect(conversation.requests).toEqual([
    {
      requestKey: "resp_0000000008",
      messageKey: "msg_00000000-0000-7000-0000-00000000ffff",
      modelRaw: "gpt-5.6-sol",
      routeHint: "openai",
      requestedAt: "2026-09-20T10:58:21.802Z",
      usage: {
        inputTokens: 12322,
        cacheReadTokens: 4864,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 93,
        reasoningTokens: 37,
      },
      usageBasis: "reported",
      sourceRecordKey: usageRow.recordKey,
    },
  ]);
});

test("without token_usage_record the three token_count modes and both repeat guards apply", async () => {
  const conversation = normalized(await rowsOf(legacy));
  expect(
    conversation.requests.map((request) => [
      request.requestKey,
      request.usageBasis,
      request.modelRaw,
    ]),
  ).toEqual([
    ["ordinal:4", "reported", "gpt-5.1-codex"],
    ["ordinal:6", "cumulative_delta", "gpt-5.1-codex"],
  ]);
  expect(conversation.requests.map((request) => request.usage)).toEqual([
    {
      inputTokens: 800,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 50,
      reasoningTokens: 10,
    },
    {
      inputTokens: 1000,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 70,
      reasoningTokens: 30,
    },
  ]);
});

test("the same rollout from two machines, in any order, normalizes once", async () => {
  const single = normalized(await rowsOf(guardian));
  const first = await rowsOf(guardian, "machine-a");
  const second = await rowsOf(guardian, "machine-b", "2026-09-21T06:00:00.000Z");
  const shuffled = [...second, ...first].reverse();
  expect(normalized(shuffled)).toEqual(single);
});

test("records that hold no conversation normalize to null", () => {
  const streamId = StreamId.make(`abc/jsonl/${guardian}`);
  const rows: ReadonlyArray<SourceRecordRow> = [
    {
      streamId,
      recordKey: RecordKey.make("0"),
      payload: `{"timestamp":"2026-09-20T10:58:18.048Z","ordinal":0,"type":"session_meta","payload":{"id":"x"}}`,
      observedAt: "2026-09-21T00:00:00.000Z",
    },
    {
      streamId,
      recordKey: RecordKey.make("1"),
      payload: `{"record_type":"state"}`,
      observedAt: "2026-09-21T00:00:00.000Z",
    },
    {
      streamId,
      recordKey: RecordKey.make("2"),
      payload: "not json",
      observedAt: "2026-09-21T00:00:00.000Z",
    },
  ];
  expect(codexNormalizer.normalize("00000000-0000-7000-0000-00000000bbbb", rows)).toBeNull();
});

test("rollouts without ordinals preserve usage and deduplicate copies across machines", async () => {
  const original = await rowsOf(legacy);
  const withoutOrdinals = original.map((row) => ({
    ...row,
    payload: row.payload.replace(/"ordinal":\s*\d+,?\s*/g, ""),
  }));
  const single = normalized(withoutOrdinals);
  expect(single.requests.map(({ usage, modelRaw }) => ({ usage, modelRaw }))).toEqual(
    normalized(original).requests.map(({ usage, modelRaw }) => ({ usage, modelRaw })),
  );
  expect(single.messages.length).toBe(normalized(original).messages.length);
  const otherMachine = withoutOrdinals.map((row) => ({
    ...row,
    streamId: StreamId.make(row.streamId.replace("machine-a", "machine-b")),
  }));
  expect(normalized([...otherMachine, ...withoutOrdinals].reverse())).toEqual(single);
});

test("forks keep their own usage and ignore replayed usage owned by the parent thread", () => {
  const child = "00000000-0000-7000-0000-00000000bbbb";
  const parent = "00000000-0000-7000-0000-00000000aaaa";
  const streamId = StreamId.make(`machine-a/jsonl/${guardian}`);
  const row = (ordinal: number, type: string, payload: Schema.JsonObject): SourceRecordRow => ({
    streamId,
    recordKey: RecordKey.make(String(ordinal)),
    observedAt: "2026-09-21T00:00:00.000Z",
    payload: JSON.stringify({ ordinal, timestamp: "2026-09-20T10:58:30.000Z", type, payload }),
  });
  const header = row(0, "session_meta", {
    id: child,
    session_id: parent,
    parent_thread_id: parent,
  });
  const usage = { input_tokens: 100, output_tokens: 10 };
  const inherited = row(1, "token_usage_record", {
    thread_id: parent,
    response_id: "parent-response",
    usage,
  });
  const own = row(2, "token_usage_record", {
    thread_id: child,
    response_id: "child-response",
    usage,
  });
  expect(
    normalized([header, inherited, own]).requests.map((request) => request.requestKey),
  ).toEqual(["child-response"]);
  const legacy = row(3, "event_msg", { type: "token_count", info: { last_token_usage: usage } });
  const withLegacy = normalized([
    header,
    inherited,
    { ...legacy, payload: legacy.payload.replace("10:58:30", "10:58:40") },
  ]);
  expect(withLegacy.requests.map((request) => request.requestKey)).toEqual(["ordinal:3"]);
});

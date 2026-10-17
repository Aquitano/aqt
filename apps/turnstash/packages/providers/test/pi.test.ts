import { expect, test } from "bun:test";
import { join } from "node:path";

import { RecordKey, streamIdOf, type SourceRecordRow, type SourceRoot } from "@aqt/turnstash-core";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Option } from "effect";

import { piNormalizer, piSource } from "../src/pi/index.ts";

const root: SourceRoot = { path: join(import.meta.dir, "fixtures/pi/sessions"), label: "pi" };
const otherMachine: SourceRoot = { path: "/home/other/.pi/agent/sessions", label: "pi" };

const project = "--Users-dev-Code-demo--";
const mainTranscript = `${project}/2026-09-04T22-49-56.397Z_019bd7a3-1c00-7f2a-9c41-0a1b2c3d4e5f.jsonl`;
const subagentTranscript = `${project}/019bd7a3-1c00-7f2a-9c41-0a1b2c3d4e5f/reviewer.jsonl`;
const metadataTranscript = `${project}/2026-09-05T08-00-00.000Z_019bdb11-2200-7a01-8f55-aabbccddeeff.jsonl`;
const mainKey = "019bd7a3-1c00-7f2a-9c41-0a1b2c3d4e5f";
const subagentKey = `019bd7a3-1c00-7f2a-9c41-0a1b2c3d4e5f/reviewer.jsonl`;

const nth = <A>(items: ReadonlyArray<A>, index: number): A => {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
};

const rowsOf = async (
  relativePath: string,
  options: { readonly machine?: SourceRoot; readonly observedAt?: string } = {},
): Promise<ReadonlyArray<SourceRecordRow>> => {
  const streamId = streamIdOf({ kind: "jsonl", root: options.machine ?? root, relativePath });
  const lines = (await Bun.file(join(root.path, relativePath)).text()).split("\n");
  if (lines.at(-1) === "") lines.pop();
  const encoder = new TextEncoder();
  const rows: Array<SourceRecordRow> = [];
  let offset = 0;
  for (const line of lines) {
    rows.push({
      streamId,
      recordKey: RecordKey.make(String(offset)),
      payload: line,
      observedAt: options.observedAt ?? "2026-09-06T00:00:00.000Z",
    });
    offset += encoder.encode(line).byteLength + 1;
  }
  return rows;
};

const normalized = async (relativePath: string, conversationKey: string) => {
  const conversation = piNormalizer.normalize(conversationKey, await rowsOf(relativePath));
  if (conversation === null) throw new Error(`${relativePath} did not normalize`);
  return conversation;
};

test("roots cover the Pi and OMP session directories per OS, env overrides first", () => {
  expect(
    piSource.roots({ os: "darwin", home: "/Users/dev", env: {} }).map((root) => root.path),
  ).toEqual(["/Users/dev/.pi/agent/sessions", "/Users/dev/.omp/agent/sessions"]);
  expect(
    piSource.roots({ os: "win32", home: "C:\\Users\\dev", env: {} }).map((root) => root.path),
  ).toEqual(["C:\\Users\\dev\\.pi\\agent\\sessions", "C:\\Users\\dev\\.omp\\agent\\sessions"]);
  const overridden = piSource.roots({
    os: "linux",
    home: "/home/dev",
    env: { PI_SESSIONS_DIR: "/data/pi" },
  });
  expect(overridden.map((root) => root.path)).toEqual([
    "/data/pi",
    "/home/dev/.pi/agent/sessions",
    "/home/dev/.omp/agent/sessions",
  ]);
});

test("discovery lists project transcripts and nested subagent transcripts", async () => {
  const sources = await Effect.runPromise(
    piSource.discover(root).pipe(Effect.provide(BunServices.layer)),
  );
  expect(sources.map((source) => source.relativePath)).toEqual([
    subagentTranscript,
    mainTranscript,
    metadataTranscript,
  ]);
  expect(sources.every((source) => source.kind === "jsonl")).toBe(true);
});

test("every line of a transcript resolves to the same conversation key, blank padding to none", async () => {
  const rows = await rowsOf(mainTranscript);
  const keys = rows.map((row) => piNormalizer.conversationKeyOf(row.streamId, row.payload));
  expect([...new Set(keys.map(Option.getOrNull))]).toEqual([mainKey]);

  const subagentRows = await rowsOf(subagentTranscript);
  expect(
    Option.isNone(
      piNormalizer.conversationKeyOf(nth(subagentRows, 0).streamId, nth(subagentRows, 0).payload),
    ),
  ).toBe(true);
  const fromHeader = piNormalizer.conversationKeyOf(
    nth(subagentRows, 1).streamId,
    nth(subagentRows, 1).payload,
  );
  const fromMessage = piNormalizer.conversationKeyOf(
    nth(subagentRows, 2).streamId,
    nth(subagentRows, 2).payload,
  );
  expect([Option.getOrNull(fromHeader), Option.getOrNull(fromMessage)]).toEqual([
    subagentKey,
    subagentKey,
  ]);
});

test("messages keep record order and content order, tool results are not messages", async () => {
  const conversation = await normalized(mainTranscript, mainKey);
  expect(conversation.title).toBe("Demo session");
  expect(conversation.projectPath).toBe("/Users/dev/Code/demo");
  expect(conversation.startedAt).toBe("2026-09-04T22:49:56.397Z");
  expect(conversation.endedAt).toBe("2026-09-04T22:51:40.500Z");
  expect(
    conversation.messages.map((message) => [
      message.messageKey,
      message.role,
      message.parentMessageKey,
    ]),
  ).toEqual([
    ["a845e857", "user", undefined],
    ["38a4e25b", "assistant", "a845e857"],
    ["9c1f2a30", "assistant", undefined],
    ["4ab09c77", "system", "9c1f2a30"],
    ["c0112233", "assistant", "4ab09c77"],
    ["d4455667", "assistant", "c0112233"],
  ]);
  const assistant = nth(conversation.messages, 1);
  expect(assistant.parts).toEqual([
    { type: "thinking", text: "check the directory first" },
    { type: "text", text: "Listing the demo files." },
    { type: "tool_call", toolKey: "call_AAAA1111", name: "bash", input: { command: "ls demo" } },
  ]);
  expect(assistant.text).toBe("check the directory first\nListing the demo files.\nbash");
  expect(nth(conversation.messages, 3).parts).toEqual([
    { type: "text", text: "the demo looks fine" },
    {
      type: "opaque",
      kind: "subagent-result",
      data: { id: "run-0001", status: "completed", title: "reviewer" },
    },
  ]);
});

test("tool executions pair a call with its result and keep an unanswered call open", async () => {
  const conversation = await normalized(mainTranscript, mainKey);
  expect(conversation.toolExecutions).toEqual([
    {
      toolKey: "call_AAAA1111",
      messageKey: "38a4e25b",
      name: "bash",
      input: { command: "ls demo" },
      output: "README.md\nmain.ts",
      status: "ok",
      startedAt: "2026-09-04T22:50:12.601Z",
      endedAt: "2026-09-04T22:50:13.342Z",
    },
    {
      toolKey: "call_BBBB2222",
      messageKey: "9c1f2a30",
      name: "subagent_spawn",
      input: {
        name: "reviewer",
        harness: "omp",
        prompt: "review the demo",
        reasoning_effort: "medium",
        working_dir: "/Users/dev/Code/demo",
      },
      output: null,
      status: "unknown",
      startedAt: "2026-09-04T22:50:20.947Z",
    },
    {
      toolKey: "call_CCCC3333",
      messageKey: "d4455667",
      name: "read",
      input: { path: "/Users/dev/Code/demo/missing.ts" },
      output: "no such file",
      status: "error",
      startedAt: "2026-09-04T22:51:40.100Z",
      endedAt: "2026-09-04T22:51:40.500Z",
    },
  ]);
});

test("requests report the 1h cache bucket, keep reasoning inside output and skip aborted turns", async () => {
  const conversation = await normalized(mainTranscript, mainKey);
  expect(conversation.requests.map((request) => request.requestKey)).toEqual([
    "resp-0001",
    "9c1f2a30",
    "resp-0002",
  ]);
  expect(nth(conversation.requests, 0)).toEqual({
    requestKey: "resp-0001",
    messageKey: "38a4e25b",
    modelRaw: "opencode-go/deepseek-v4-pro",
    routeHint: "opencode-go",
    requestedAt: "2026-09-04T22:50:12.601Z",
    usage: {
      inputTokens: 1636,
      cacheReadTokens: 6016,
      cacheWriteTokens: 64,
      cacheWrite1hTokens: 64,
      outputTokens: 223,
      reasoningTokens: 39,
    },
    usageBasis: "reported",
    sourceRecordKey: nth(await rowsOf(mainTranscript), 4).recordKey,
  });
});

test("the same transcript from two machines, in any order, normalizes once", async () => {
  const single = await normalized(mainTranscript, mainKey);
  const one = await rowsOf(mainTranscript);
  const two = await rowsOf(mainTranscript, {
    machine: otherMachine,
    observedAt: "2026-09-07T12:00:00.000Z",
  });
  const conversation = piNormalizer.normalize(mainKey, [...two, ...one].reverse());
  expect(conversation).toEqual(single);
});

test("a subagent transcript links its parent session and accepts string content", async () => {
  const conversation = await normalized(subagentTranscript, subagentKey);
  expect(conversation.parentConversationKey).toBe(mainKey);
  expect(conversation.title).toBeUndefined();
  expect(conversation.messages.map((message) => [message.role, message.text])).toEqual([
    ["user", "review the demo"],
    ["assistant", "the demo looks fine"],
  ]);
  expect(nth(conversation.requests, 0).modelRaw).toBe("anthropic/claude-sonnet-9");
});

test("a transcript holding only metadata is not a conversation", async () => {
  const rows = await rowsOf(metadataTranscript);
  expect(piNormalizer.normalize("019bdb11-2200-7a01-8f55-aabbccddeeff", rows)).toBeNull();
});

import { expect, test } from "bun:test";
import { join } from "node:path";

import {
  type HostEnv,
  RecordKey,
  type SourceDescriptor,
  type SourceRecordRow,
  type SourceRoot,
  streamIdOf,
} from "@aqt/turnstash-core";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Option } from "effect";

import { claudeNormalizer, claudeSource } from "../src/claude/index.ts";
import { jsonlRows } from "./support.ts";

const fixtures = join(import.meta.dir, "fixtures", "claude");
const configRoot: SourceRoot = { path: join(fixtures, "config"), label: "Claude Code" };
const desktopRoot: SourceRoot = { path: join(fixtures, "desktop"), label: "Claude Desktop" };

const session = "11111111-1111-4111-8111-111111111111";
const transcript = `projects/example-slug/${session}.jsonl`;
const subagentTranscript = `projects/example-slug/${session}/subagents/agent-aaaaaaaaaaaaaaaaa.jsonl`;
const subagentMeta = `projects/example-slug/${session}/subagents/agent-aaaaaaaaaaaaaaaaa.meta.json`;
const workflowTranscript = `projects/example-slug/${session}/subagents/workflows/wf_9999999-aaa/agent-bbbbbbbbbbbbbbbbb.jsonl`;

const rowsOf = async (
  relativePath: string,
  root: SourceRoot = configRoot,
  observedAt = "2026-09-21T12:00:00.000Z",
): Promise<ReadonlyArray<SourceRecordRow>> => {
  const kind = relativePath.endsWith(".jsonl") ? "jsonl" : "json";
  const streamId = streamIdOf({ kind, root, relativePath });
  const text = await Bun.file(join(configRoot.path, relativePath)).text();
  if (kind === "json")
    return [{ streamId, recordKey: RecordKey.make("0"), payload: text, observedAt }];
  return jsonlRows(streamId, text, observedAt);
};

const conversationRows = async (root: SourceRoot = configRoot) => [
  ...(await rowsOf(transcript, root)),
  ...(await rowsOf(subagentTranscript, root)),
  ...(await rowsOf(subagentMeta, root)),
];

const normalized = async (root?: SourceRoot) => {
  const conversation = claudeNormalizer.normalize(session, await conversationRows(root));
  if (conversation === null) throw new Error("expected a conversation");
  return conversation;
};

const discover = (root: SourceRoot) =>
  Effect.runPromise(
    claudeSource.discover(root).pipe(
      Effect.map((sources: ReadonlyArray<SourceDescriptor>) =>
        sources.map((source) => source.relativePath),
      ),
      Effect.provide(BunServices.layer),
    ),
  );

const host = (over: Partial<HostEnv>): HostEnv => ({
  os: "darwin",
  home: "/home/dev",
  env: {},
  ...over,
});

test("roots put env overrides first and add the desktop sessions dir per OS", () => {
  expect(
    claudeSource
      .roots(host({ env: { CLAUDE_CONFIG_DIRS: "~/alt:/opt/claude:~/alt" } }))
      .map((root) => root.path),
  ).toEqual([
    "/home/dev/alt",
    "/opt/claude",
    "/home/dev/Library/Application Support/Claude/local-agent-mode-sessions",
  ]);
  expect(
    claudeSource
      .roots(host({ env: { CLAUDE_CONFIG_DIR: "/opt/claude" } }))
      .map((root) => root.path),
  ).toEqual([
    "/opt/claude",
    "/home/dev/Library/Application Support/Claude/local-agent-mode-sessions",
  ]);
  expect(
    claudeSource
      .roots(host({ os: "linux", env: { XDG_CONFIG_HOME: "/home/dev/.config" } }))
      .map((r) => r.path),
  ).toEqual(["/home/dev/.claude", "/home/dev/.config/Claude/local-agent-mode-sessions"]);
  expect(
    claudeSource
      .roots(
        host({
          os: "win32",
          home: "C:\\Users\\dev",
          env: {
            APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
            LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
          },
        }),
      )
      .map((root) => root.path),
  ).toEqual([
    "C:\\Users\\dev\\.claude",
    "C:\\Users\\dev\\AppData\\Roaming\\Claude\\local-agent-mode-sessions",
    "C:\\Users\\dev\\AppData\\Local\\Packages",
  ]);
  expect(
    claudeSource
      .roots(host({ env: { TURNSTASH_DESKTOP_SESSIONS_DIR: "/sessions" } }))
      .map((root) => root.path),
  ).toEqual(["/home/dev/.claude", "/sessions"]);
});

test("discover lists transcripts, subagents and meta sidecars but skips the rest", async () => {
  expect(await discover(configRoot)).toEqual([
    transcript,
    subagentTranscript,
    subagentMeta,
    workflowTranscript,
  ]);
  expect(await discover(desktopRoot)).toEqual([
    "app-1/ws-1/local_22222222-2222-4222-8222-222222222222/.claude/projects/desktop-slug/22222222-2222-4222-8222-222222222222.jsonl",
  ]);
  expect(await discover({ path: join(fixtures, "missing"), label: "missing" })).toEqual([]);
});

test("the conversation key is the record sessionId, falling back to the path", async () => {
  const rows = await conversationRows();
  const keyOf = (row: SourceRecordRow) =>
    claudeNormalizer.conversationKeyOf(row.streamId, row.payload);
  expect(rows.map(keyOf).every((key) => Option.getOrNull(key) === session)).toBe(true);
  const workflow = await rowsOf(workflowTranscript);
  expect(workflow.map(keyOf)).toEqual([Option.some("33333333-3333-4333-8333-333333333333")]);
  const [meta] = await rowsOf(subagentMeta);
  expect(meta !== undefined && Option.getOrNull(keyOf({ ...meta, payload: "not json" }))).toBe(
    session,
  );
  const orphan = streamIdOf({
    kind: "jsonl",
    root: configRoot,
    relativePath: "projects/example-slug/notes.jsonl",
  });
  expect(claudeNormalizer.conversationKeyOf(orphan, "{}")).toEqual(Option.none());
});

test("messages keep byte order, pair tool calls with results and carry conversation metadata", async () => {
  const conversation = await normalized();
  expect(conversation.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant",
    "tool",
    "system",
    "system",
    "assistant",
    "user",
    "assistant",
  ]);
  expect(conversation.messages[5]?.createdAt).toBe("2026-09-21T09:00:01.000Z");
  expect(conversation.messages[5]?.parts[0]).toEqual({
    type: "opaque",
    kind: "attachment:hook_success",
    data: expect.objectContaining({ hookName: "PostToolUse" }),
  });
  expect(conversation.toolExecutions).toEqual([
    {
      toolKey: "toolu_0000000000000000000001",
      messageKey: "msg_0000000000000000000001",
      name: "Read",
      input: { file_path: "/home/dev/project/src/index.ts" },
      output: "export const run = () => 0\n",
      status: "ok",
      startedAt: "2026-09-21T09:00:04.100Z",
      endedAt: "2026-09-21T09:00:04.620Z",
    },
    {
      toolKey: "toolu_0000000000000000000002",
      messageKey: "msg_0000000000000000000002",
      name: "Agent",
      input: { subagent_type: "Explore", description: "look up the config loader" },
      output: "The loader lives in src/config.ts",
      status: "ok",
      startedAt: "2026-09-21T09:00:10.000Z",
      endedAt: "2026-09-21T09:01:30.000Z",
    },
  ]);
  expect(conversation.title).toBe("Summarize the entry point");
  expect(conversation.projectPath).toBe("/home/dev/project");
  expect(conversation.gitBranch).toBe("main");
  expect(conversation.clientVersion).toBe("2.1.278");
  expect(conversation.startedAt).toBe("2026-09-21T09:00:00.000Z");
  expect(conversation.endedAt).toBe("2026-09-21T09:01:40.000Z");
});

test("a streaming group becomes one message and one request billed from its last line", async () => {
  const conversation = await normalized();
  const lastGroupLine = (await rowsOf(transcript))[3]?.recordKey ?? "";
  const message = conversation.messages[1];
  expect(message?.messageKey).toBe("msg_0000000000000000000001");
  expect(message?.parts.map((part) => part.type)).toEqual(["thinking", "text", "tool_call"]);
  expect(message?.text).toBe("Read the entry point first.\nReading the entry point.\nRead");
  const requests = conversation.requests.filter(
    (request) => request.requestKey === "msg_0000000000000000000001",
  );
  expect(requests).toEqual([
    {
      requestKey: "msg_0000000000000000000001",
      messageKey: "msg_0000000000000000000001",
      modelRaw: "claude-opus-5",
      requestedAt: "2026-09-21T09:00:03.000Z",
      usage: {
        inputTokens: 4,
        cacheReadTokens: 58204,
        cacheWriteTokens: 1000,
        cacheWrite1hTokens: 512,
        outputTokens: 137,
        reasoningTokens: 72,
      },
      usageBasis: "reported",
      speed: "standard",
      sourceRecordKey: lastGroupLine,
    },
  ]);
});

test("extra iterations bill separately and synthetic error messages bill nothing", async () => {
  const conversation = await normalized();
  expect(
    conversation.requests.map((request) => [
      request.requestKey,
      request.modelRaw,
      request.usage.outputTokens,
    ]),
  ).toEqual([
    ["msg_0000000000000000000001", "claude-opus-5", 137],
    ["msg_0000000000000000000002", "claude-sonnet-5", 90],
    ["msg_0000000000000000000002#0", "claude-opus-5", 25],
    ["msg_0000000000000000000010", "claude-haiku-4-5-20251001", 40],
  ]);
  expect(conversation.requests[2]?.usage).toEqual({
    inputTokens: 10,
    cacheReadTokens: 58000,
    cacheWriteTokens: 100,
    cacheWrite1hTokens: 0,
    outputTokens: 25,
    reasoningTokens: 0,
  });
  expect(conversation.requests[3]?.speed).toBe("fast");
  expect(conversation.messages[7]?.text).toBe("API Error: 429 rate limit");
});

test("subagent records join the parent conversation and link to the spawning tool call", async () => {
  const conversation = await normalized();
  const spawned = conversation.messages[8];
  expect(spawned?.text).toBe("Find the config loader");
  expect(spawned?.parentMessageKey).toBe("msg_0000000000000000000002");
  expect(conversation.messages[9]?.parentMessageKey).toBe(spawned?.messageKey);
});

test("the same session seen from two machines normalizes to the same conversation", async () => {
  const one = await normalized();
  const otherMachine: SourceRoot = { path: "/other/machine/.claude", label: "Claude Code" };
  const other = claudeNormalizer.normalize(
    session,
    [...(await conversationRows()), ...(await conversationRows(otherMachine))].toReversed(),
  );
  expect(other).toEqual(one);
});

test("metadata-only records do not form a conversation", () => {
  const streamId = streamIdOf({ kind: "jsonl", root: configRoot, relativePath: transcript });
  const rows: ReadonlyArray<SourceRecordRow> = [
    {
      streamId,
      recordKey: RecordKey.make("0"),
      payload: JSON.stringify({ type: "cost-state", sessionId: session, totalCostUSD: 1 }),
      observedAt: "2026-09-21T12:00:00.000Z",
    },
  ];
  expect(claudeNormalizer.normalize(session, rows)).toBeNull();
});

test("a request whose message names no model is billed as unknown", () => {
  const streamId = streamIdOf({ kind: "jsonl", root: configRoot, relativePath: transcript });
  const payload = JSON.stringify({
    type: "assistant",
    uuid: "00000000-0000-4000-8000-000000000002",
    timestamp: "2026-09-21T09:00:03.000Z",
    sessionId: session,
    message: {
      id: "msg_0000000000000000000001",
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      usage: { input_tokens: 4, output_tokens: 30 },
    },
  });
  const conversation = claudeNormalizer.normalize(session, [
    { streamId, recordKey: RecordKey.make("0"), payload, observedAt: "2026-09-21T12:00:00.000Z" },
  ]);
  expect(conversation?.requests.map((request) => request.modelRaw)).toEqual(["unknown"]);
});

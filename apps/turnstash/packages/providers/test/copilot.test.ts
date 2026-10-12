import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RecordKey,
  streamIdOf,
  type NormalizedConversation,
  type SourceRecordRow,
  type SourceRoot,
} from "@aqt/turnstash-core";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Option } from "effect";

import { copilotNormalizer, copilotSource } from "../src/copilot/index.ts";
import store from "./fixtures/copilot/session-store.json";
import { canonical, jsonlRows } from "./support.ts";

const sessionId = "11111111-1111-4111-8111-111111111111";
const observedAt = "2026-05-22T09:00:00.000Z";
const journalRoot: SourceRoot = {
  path: "/home/a/.copilot/session-state",
  label: "copilot-cli-sessions",
};
const storeRoot: SourceRoot = { path: "/home/a/.copilot", label: "copilot-cli-store" };
const otherJournalRoot: SourceRoot = {
  path: "/Users/b/.copilot/session-state",
  label: "copilot-cli-sessions",
};
const otherStoreRoot: SourceRoot = { path: "/Users/b/.copilot", label: "copilot-cli-store" };

const events = await Bun.file(
  join(import.meta.dir, "fixtures/copilot/session-state", sessionId, "events.jsonl"),
).text();

const journalRecords = (root: SourceRoot): ReadonlyArray<SourceRecordRow> =>
  jsonlRows(
    streamIdOf({ kind: "jsonl", root, relativePath: `${sessionId}/events.jsonl` }),
    events,
    observedAt,
  );

const tableRecord = (
  root: SourceRoot,
  table: string,
  row: Record<string, unknown>,
): SourceRecordRow => ({
  streamId: streamIdOf({
    kind: "sqlite",
    root,
    relativePath: "session-store.db",
    table,
    keyColumn: "id",
  }),
  recordKey: RecordKey.make(String(row["id"])),
  payload: canonical(row),
  observedAt,
});

const normalized = (records: ReadonlyArray<SourceRecordRow>): NormalizedConversation => {
  const conversation = copilotNormalizer.normalize(sessionId, records);
  if (conversation === null) throw new Error("expected a conversation");
  return conversation;
};

const requestOf = (conversation: NormalizedConversation, requestKey: string) =>
  conversation.requests.find((request) => request.requestKey === requestKey);

test("roots cover the CLI journals, both stores and every VS Code variant", () => {
  expect(
    copilotSource.roots({ os: "darwin", home: "/Users/a", env: {} }).map((root) => root.path),
  ).toEqual([
    "/Users/a/.copilot/session-state",
    "/Users/a/.copilot",
    "/Users/a/Library/Application Support/Code/User/globalStorage/github.copilot-chat",
    "/Users/a/Library/Application Support/Code - Insiders/User/globalStorage/github.copilot-chat",
    "/Users/a/Library/Application Support/VSCodium/User/globalStorage/github.copilot-chat",
    "/Users/a/Library/Application Support/Code/User/workspaceStorage",
    "/Users/a/Library/Application Support/Code - Insiders/User/workspaceStorage",
    "/Users/a/Library/Application Support/VSCodium/User/workspaceStorage",
  ]);

  const windows = copilotSource.roots({
    os: "win32",
    home: "C:\\Users\\a",
    env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" },
  });
  expect(windows[0]?.path).toBe("C:\\Users\\a\\.copilot\\session-state");
  expect(windows[2]?.path).toBe(
    "C:\\Users\\a\\AppData\\Roaming\\Code\\User\\globalStorage\\github.copilot-chat",
  );

  const overridden = copilotSource.roots({
    os: "linux",
    home: "/home/a",
    env: {
      TURNSTASH_COPILOT_SESSION_STATE_DIR: "/mnt/journals",
      TURNSTASH_COPILOT_SESSION_STORE_DB: "/mnt/store/session-store.db",
      TURNSTASH_COPILOT_GLOBAL_STORAGE_DIR: "/mnt/vscode/globalStorage",
      TURNSTASH_COPILOT_WORKSPACE_STORAGE_DIR: "/mnt/vscode/workspaceStorage",
    },
  });
  expect(overridden.map((root) => root.path)).toEqual([
    "/mnt/journals",
    "/mnt/store",
    "/mnt/vscode/globalStorage/github.copilot-chat",
    "/mnt/vscode/workspaceStorage",
  ]);
});

test("an empty VS Code storage override uses the default roots", () => {
  for (const os of ["linux", "win32"] as const) {
    const host = { os, home: os === "win32" ? "C:\\Users\\a" : "/home/a", env: {} };
    expect(
      copilotSource.roots({
        ...host,
        env: { TURNSTASH_COPILOT_GLOBAL_STORAGE_DIR: "" },
      }),
    ).toEqual(copilotSource.roots(host));
  }
});

test("discovery lists journals and only the store tables the database actually has", async () => {
  const root = await mkdtemp(join(tmpdir(), "turnstash-copilot-"));
  try {
    await mkdir(join(root, "session-state", sessionId), { recursive: true });
    await mkdir(join(root, "vscode"), { recursive: true });
    await Bun.write(join(root, "session-state", sessionId, "events.jsonl"), events);
    await Bun.write(join(root, "session-state", sessionId, "workspace.yaml"), "id: session\n");
    await Bun.write(join(root, "vscode", "notes.db"), "not a database");

    const narrow = new Database(join(root, "session-store.db"), { create: true });
    narrow.run(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT)",
    );
    narrow.run(
      "CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, user_message TEXT, assistant_response TEXT, timestamp TEXT)",
    );
    narrow.run(
      "CREATE TABLE checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL)",
    );
    narrow.close();

    const wide = new Database(join(root, "vscode", "session-store.db"), { create: true });
    wide.run(
      "CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, model TEXT, input_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, created_at TEXT)",
    );
    wide.close();

    const discover = (candidate: SourceRoot) =>
      Effect.runPromise(copilotSource.discover(candidate).pipe(Effect.provide(BunServices.layer)));

    expect(
      await discover({ path: join(root, "session-state"), label: "copilot-cli-sessions" }),
    ).toEqual([
      {
        kind: "jsonl",
        root: { path: join(root, "session-state"), label: "copilot-cli-sessions" },
        relativePath: `${sessionId}/events.jsonl`,
      },
    ]);

    const cliStore = { path: root, label: "copilot-cli-store" };
    expect(await discover(cliStore)).toEqual([
      {
        kind: "sqlite",
        root: cliStore,
        relativePath: "session-store.db",
        table: "sessions",
        keyColumn: "id",
      },
      {
        kind: "sqlite",
        root: cliStore,
        relativePath: "session-store.db",
        table: "turns",
        keyColumn: "id",
      },
    ]);

    const vscodeStore = { path: join(root, "vscode"), label: "copilot-vscode-store" };
    expect(await discover(vscodeStore)).toEqual([
      {
        kind: "sqlite",
        root: vscodeStore,
        relativePath: "session-store.db",
        table: "assistant_usage_events",
        keyColumn: "id",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy CLI journals are discovered and use the initial selected model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turnstash-copilot-legacy-"));
  try {
    const root = { path: directory, label: "copilot-cli-sessions" };
    const journal =
      [
        { type: "session.start", timestamp: observedAt, data: { selectedModel: "gpt-5.1" } },
        { type: "user.message", timestamp: observedAt, data: { content: "Explain the build" } },
        {
          type: "assistant.message",
          timestamp: observedAt,
          data: { messageId: "answer", content: "Run the build command." },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n";
    await Bun.write(join(directory, `${sessionId}.jsonl`), journal);
    const descriptors = await Effect.runPromise(
      copilotSource.discover(root).pipe(Effect.provide(BunServices.layer)),
    );
    expect(descriptors).toHaveLength(1);
    const descriptor = descriptors[0];
    if (descriptor === undefined) throw new Error("expected legacy journal");
    const streamId = streamIdOf(descriptor);
    expect(Option.getOrNull(copilotNormalizer.conversationKeyOf(streamId, ""))).toBe(sessionId);
    const conversation = normalized(jsonlRows(streamId, journal, observedAt));
    expect(conversation.messages.map((message) => message.text)).toEqual([
      "Explain the build",
      "Run the build command.",
    ]);
    expect(conversation.requests[0]?.modelRaw).toBe("gpt-5.1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("conversation keys come from the journal path and the store session columns", () => {
  const key = (record: SourceRecordRow) =>
    Option.getOrNull(copilotNormalizer.conversationKeyOf(record.streamId, record.payload));
  const journal = journalRecords(journalRoot)[0];
  expect(journal === undefined ? null : key(journal)).toBe(sessionId);
  expect(key(tableRecord(storeRoot, "sessions", store.session))).toBe(sessionId);
  expect(key(tableRecord(storeRoot, "turns", store.turns[0] ?? {}))).toBe(sessionId);
  expect(key(tableRecord(storeRoot, "assistant_usage_events", store.paired[0] ?? {}))).toBe(
    sessionId,
  );
  expect(key(tableRecord(storeRoot, "checkpoints", { id: 9, session_id: sessionId }))).toBeNull();
});

test("the journal becomes messages, parts and paired tool executions", () => {
  const conversation = normalized(journalRecords(journalRoot));
  expect(conversation.title).toBeUndefined();
  expect(conversation.projectPath).toBe("/work/demo-app");
  expect(conversation.gitBranch).toBe("main");
  expect(conversation.clientVersion).toBe("1.0.12");
  expect(conversation.startedAt).toBe("2026-05-21T11:20:44.063Z");
  expect(conversation.endedAt).toBe("2026-05-21T11:50:00.000Z");
  expect(conversation.messages.map((message) => message.messageKey)).toEqual([
    "user:i-0001",
    "assistant:m-0001",
    "tool:call_0001:result",
    "assistant:m-0002",
    "error:e-0011",
    "compaction:e-0013",
    "user:i-0002",
    "assistant:m-0003",
  ]);
  expect(conversation.messages[1]?.parts).toEqual([
    { type: "thinking", text: "Read the build log before guessing." },
    {
      type: "tool_call",
      toolKey: "tool:call_0001",
      name: "bash",
      input: { command: "tail -n 40 build.log", description: "read the build log" },
    },
  ]);
  expect(conversation.messages[2]?.role).toBe("tool");
  expect(conversation.toolExecutions).toEqual([
    {
      toolKey: "tool:call_0001",
      messageKey: "assistant:m-0001",
      name: "bash",
      input: { command: "tail -n 40 build.log", description: "read the build log" },
      output: "error: missing module demo-utils in packages/api",
      status: "ok",
      startedAt: "2026-05-21T11:21:39.980Z",
      endedAt: "2026-05-21T11:21:40.938Z",
    },
  ]);
});

test("without a store the journal outputs stand and the rollup legs add only what they still claim", () => {
  const conversation = normalized(journalRecords(journalRoot));
  expect(conversation.requests.map((request) => request.requestKey)).toEqual([
    "request:m-0001",
    "request:m-0002",
    "request:m-0003",
    "shutdown:gpt-5-mini:0",
    "shutdown:gpt-5-mini:1",
  ]);
  const first = requestOf(conversation, "request:m-0001");
  expect(first?.modelRaw).toBe("gpt-5-mini");
  expect(first?.usageBasis).toBe("reported");
  expect(first?.usage).toEqual({
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 873,
    reasoningTokens: 0,
  });
  const leg = requestOf(conversation, "shutdown:gpt-5-mini:0");
  expect(leg?.usageBasis).toBe("cumulative_delta");
  expect(leg?.usage).toEqual({
    inputTokens: 17300,
    cacheReadTokens: 34128,
    cacheWriteTokens: 500,
    cacheWrite1hTokens: 0,
    outputTokens: 0,
    reasoningTokens: 120,
  });
  expect(requestOf(conversation, "shutdown:gpt-5-mini:1")?.usage).toEqual({
    inputTokens: 3000,
    cacheReadTokens: 6000,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  });
});

test("store rows fold their input and cache into the message they belong to and retire the leg", () => {
  const conversation = normalized([
    ...journalRecords(journalRoot),
    ...store.paired.map((row) => tableRecord(storeRoot, "assistant_usage_events", row)),
  ]);
  expect(requestOf(conversation, "request:m-0001")?.usage).toEqual({
    inputTokens: 15800,
    cacheReadTokens: 16128,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 873,
    reasoningTokens: 0,
  });
  expect(requestOf(conversation, "request:m-0002")?.usage).toEqual({
    inputTokens: 1500,
    cacheReadTokens: 18000,
    cacheWriteTokens: 500,
    cacheWrite1hTokens: 0,
    outputTokens: 646,
    reasoningTokens: 120,
  });
  expect(requestOf(conversation, "shutdown:gpt-5-mini:0")).toBeUndefined();
  expect(conversation.requests.filter((request) => request.usage.outputTokens > 0).length).toBe(3);
});

test("rows with no journal message of their own become requests and keep their output", () => {
  const conversation = normalized([
    ...journalRecords(journalRoot),
    tableRecord(storeRoot, "assistant_usage_events", store.unpaired),
    tableRecord(storeRoot, "assistant_usage_events", store.compaction),
  ]);
  const unpaired = conversation.requests.find((request) =>
    request.requestKey.startsWith("store:4713:"),
  );
  expect(unpaired?.messageKey).toBeUndefined();
  expect(unpaired?.usage).toEqual({
    inputTokens: 1000,
    cacheReadTokens: 4000,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 500,
    reasoningTokens: 0,
  });
  const compaction = conversation.requests.find((request) =>
    request.requestKey.startsWith("store:4714:"),
  );
  expect(compaction?.usage.inputTokens).toBe(10000);
  expect(compaction?.usage.outputTokens).toBe(1200);
});

test("the same session seen from two machines normalizes to exactly one conversation", () => {
  const single = normalized([
    ...journalRecords(journalRoot),
    ...store.paired.map((row) => tableRecord(storeRoot, "assistant_usage_events", row)),
  ]);
  const doubled = normalized([
    ...journalRecords(journalRoot),
    ...store.paired.map((row) => tableRecord(storeRoot, "assistant_usage_events", row)),
    ...journalRecords(otherJournalRoot),
    ...store.paired.map((row) => tableRecord(otherStoreRoot, "assistant_usage_events", row)),
  ]);
  expect(doubled).toEqual(single);
});

test("store metadata alone is not a conversation, but its turns are", () => {
  const sessionRecord = tableRecord(storeRoot, "sessions", store.session);
  expect(copilotNormalizer.normalize(sessionId, [sessionRecord])).toBeNull();
  const conversation = normalized([
    sessionRecord,
    ...store.turns.map((turn) => tableRecord(storeRoot, "turns", turn)),
  ]);
  expect(conversation.title).toBe("Nightly build failure");
  expect(conversation.projectPath).toBe("/work/demo-app");
  expect(conversation.messages.map((message) => message.messageKey)).toEqual([
    "turn:1:user",
    "turn:1:assistant",
    "turn:2:user",
    "turn:2:assistant",
  ]);
  expect(conversation.messages[0]?.createdAt).toBe("2026-05-21T11:21:55.000Z");
  expect(conversation.requests).toEqual([]);
});

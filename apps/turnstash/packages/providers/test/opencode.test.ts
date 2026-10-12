import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RecordKey,
  streamIdOf,
  type NormalizedConversation,
  type SourceDescriptor,
  type SourceRecordRow,
  type SourceRoot,
  type SqliteTableSource,
} from "@aqt/turnstash-core";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Option } from "effect";

import { opencodeNormalizer, opencodeSource } from "../src/opencode/index.ts";
import store from "./fixtures/opencode/filestore.json";
import legacy from "./fixtures/opencode/legacy.json";
import v2 from "./fixtures/opencode/v2.json";
import { canonical } from "./support.ts";

const machineA: SourceRoot = { path: "/home/dev/.local/share/opencode", label: "opencode" };
const machineB: SourceRoot = { path: "/Users/dev/.local/share/opencode", label: "opencode" };

const encodeColumns = (row: Record<string, unknown>, blob: boolean): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if ((key !== "data" && key !== "model") || typeof value !== "object" || value === null)
        return [key, value];
      const text = JSON.stringify(value);
      return [key, blob && key === "data" ? Buffer.from(text).toString("base64") : text];
    }),
  );

const sqliteRow = (
  table: string,
  row: Record<string, unknown>,
  options: {
    readonly root?: SourceRoot;
    readonly observedAt?: string;
    readonly blob?: boolean;
  } = {},
): SourceRecordRow => {
  const descriptor: SourceDescriptor = {
    kind: "sqlite",
    root: options.root ?? machineA,
    relativePath: "opencode.db",
    table,
    keyColumn: "id",
  };
  return {
    streamId: streamIdOf(descriptor),
    recordKey: RecordKey.make(String(row["id"])),
    payload: canonical(encodeColumns(row, options.blob === true)),
    observedAt: options.observedAt ?? "2026-09-20T10:00:00.000Z",
  };
};

const jsonDocument = (
  relativePath: string,
  document: Record<string, unknown>,
): SourceRecordRow => ({
  streamId: streamIdOf({ kind: "json", root: machineA, relativePath }),
  recordKey: RecordKey.make("0"),
  payload: JSON.stringify(document),
  observedAt: "2026-09-20T10:00:00.000Z",
});

const normalized = (
  key: string,
  records: ReadonlyArray<SourceRecordRow>,
): NormalizedConversation => {
  const conversation = opencodeNormalizer.normalize(key, records);
  if (conversation === null) throw new Error(`expected a conversation for ${key}`);
  return conversation;
};

const conversationKey = (record: SourceRecordRow): string | null =>
  Option.getOrNull(opencodeNormalizer.conversationKeyOf(record.streamId, record.payload));

const at = (millis: number): string => new Date(millis).toISOString();

const v2Records = [
  sqliteRow("session_v2", v2.session_v2),
  sqliteRow("session_message", v2.assistant),
  sqliteRow("session_message", v2.user),
  sqliteRow("session_message", v2.idle),
];

const legacyRecords = [
  sqliteRow("session", legacy.session),
  sqliteRow("message", legacy.assistantMessage),
  sqliteRow("message", legacy.userMessage),
  ...legacy.parts.map((part) => sqliteRow("part", part)),
];

test("migrated file-store parts and SQLite parts normalize exactly once", () => {
  const files = legacy.parts.map((part) =>
    jsonDocument(`storage/part/${part.message_id}/${part.id}.json`, {
      ...part.data,
      id: part.id,
      messageID: part.message_id,
      sessionID: part.session_id,
    }),
  );
  const expected = normalized(legacy.session.id, legacyRecords);
  for (const records of [
    [...files, ...legacyRecords],
    [...legacyRecords, ...files],
  ]) {
    expect(normalized(legacy.session.id, records)).toEqual(expected);
  }
});

const withDbPrefix = async (
  prefix: string | undefined,
  run: () => Promise<void>,
): Promise<void> => {
  const previous = process.env["OPENCODE_DB_PREFIX"];
  if (prefix === undefined) delete process.env["OPENCODE_DB_PREFIX"];
  else process.env["OPENCODE_DB_PREFIX"] = prefix;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env["OPENCODE_DB_PREFIX"];
    else process.env["OPENCODE_DB_PREFIX"] = previous;
  }
};

const discoverIn = (root: string) =>
  Effect.runPromise(
    opencodeSource
      .discover({ path: root, label: "opencode" })
      .pipe(Effect.provide(BunServices.layer)),
  );

const withDataDirectory = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "turnstash-opencode-"));
  try {
    for (const directory of [
      "storage/session/prj_3333",
      "storage/message/ses_IIII9999",
      "storage/part/msg_JJJJ0000",
      "storage/todo",
    ]) {
      await mkdir(join(root, directory), { recursive: true });
    }
    for (const file of [
      "opencode.db",
      "opencode.db-wal",
      "opencode.db-shm",
      "opencode-dev.db",
      "mimo.db",
      "other.db",
      "storage/session/prj_3333/ses_IIII9999.json",
      "storage/message/ses_IIII9999/msg_JJJJ0000.json",
      "storage/part/msg_JJJJ0000/prt_KKKK1111.json",
      "storage/todo/ses_IIII9999.json",
    ]) {
      await Bun.write(join(root, file), "{}");
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("roots follow the XDG data directory and the data-dir override", () => {
  const pathsOf = (host: Parameters<typeof opencodeSource.roots>[0]) =>
    opencodeSource.roots(host).map((root) => root.path);
  expect(pathsOf({ os: "linux", home: "/home/dev", env: {} })).toEqual([
    "/home/dev/.local/share/opencode",
  ]);
  expect(pathsOf({ os: "darwin", home: "/Users/dev", env: {} })).toEqual([
    "/Users/dev/.local/share/opencode",
  ]);
  expect(pathsOf({ os: "win32", home: "C:\\Users\\dev", env: {} })).toEqual([
    "C:\\Users\\dev\\.local\\share\\opencode",
  ]);
  expect(pathsOf({ os: "linux", home: "/home/dev", env: { XDG_DATA_HOME: "/data" } })).toEqual([
    "/data/opencode",
  ]);
  expect(
    pathsOf({ os: "linux", home: "/home/dev", env: { OPENCODE_DATA_DIR: "/data/mimocode" } }),
  ).toEqual(["/data/mimocode", "/home/dev/.local/share/opencode"]);
});

test("discovery lists the five tables per database and the file store documents", async () => {
  await withDbPrefix(undefined, () =>
    withDataDirectory(async (root) => {
      const descriptors = await discoverIn(root);
      const tables = descriptors.filter(
        (descriptor): descriptor is SqliteTableSource => descriptor.kind === "sqlite",
      );
      const documents = descriptors.filter((descriptor) => descriptor.kind === "json");
      expect([...new Set(tables.map((table) => table.relativePath))]).toEqual([
        "opencode-dev.db",
        "opencode.db",
      ]);
      expect(
        tables.filter((table) => table.relativePath === "opencode.db").map((table) => table.table),
      ).toEqual(["session_v2", "session_message", "session", "message", "part"]);
      expect(tables.every((table) => table.keyColumn === "id")).toBe(true);
      expect(documents.map((document) => document.relativePath)).toEqual([
        "storage/session/prj_3333/ses_IIII9999.json",
        "storage/message/ses_IIII9999/msg_JJJJ0000.json",
        "storage/part/msg_JJJJ0000/prt_KKKK1111.json",
      ]);
    }),
  );
});

const databasesIn = async (root: string): Promise<ReadonlyArray<string>> => {
  const descriptors = await discoverIn(root);
  return [...new Set(descriptors.filter((d) => d.kind === "sqlite").map((d) => d.relativePath))];
};

test("the database prefix override picks a renamed fork and an empty value falls back", async () => {
  await withDataDirectory(async (root) => {
    await withDbPrefix("mimo", async () => expect(await databasesIn(root)).toEqual(["mimo.db"]));
    await withDbPrefix("", async () =>
      expect(await databasesIn(root)).toEqual(["opencode-dev.db", "opencode.db"]),
    );
  });
});

test("conversation keys come from the row's own id or from its session id", () => {
  expect(conversationKey(sqliteRow("session_v2", v2.session_v2))).toBe("ses_AAAA1111");
  expect(conversationKey(sqliteRow("session_message", v2.assistant))).toBe("ses_AAAA1111");
  expect(conversationKey(sqliteRow("session", legacy.session))).toBe("ses_EEEE5555");
  expect(
    conversationKey(
      sqliteRow("part", { id: "prt_0003", message_id: "msg_DDDD4444", session_id: "ses_EEEE5555" }),
    ),
  ).toBe("ses_EEEE5555");
  expect(
    conversationKey(jsonDocument("storage/message/ses_IIII9999/msg_JJJJ0000.json", store.message)),
  ).toBe("ses_IIII9999");
  expect(
    conversationKey({ ...sqliteRow("session_v2", v2.session_v2), payload: "{broken" }),
  ).toBeNull();
});

test("v2 messages keep seq order, pair their tools and bill reasoning inside output", () => {
  const conversation = normalized("ses_AAAA1111", v2Records);
  expect(conversation.title).toBe("Tidy the parser");
  expect(conversation.projectPath).toBe("/home/dev/projects/demo");
  expect(conversation.clientVersion).toBe("2.1.0");
  expect(conversation.startedAt).toBe(at(1789983314397));
  expect(conversation.endedAt).toBe(at(1789983315500));
  expect(
    conversation.messages.map((message) => [message.messageKey, message.role, message.seq]),
  ).toEqual([
    ["msg_USER0001", "user", 0],
    ["msg_BBBB2222", "assistant", 1],
    ["msg_IDLE0003", "system", 2],
  ]);
  const [user, assistant, idle] = conversation.messages;
  expect(user?.text).toBe("Fix the date parser");
  expect(idle?.parts).toEqual([
    {
      type: "opaque",
      kind: "idle",
      data: { outcome: "completed", time: { created: 1789983315500 } },
    },
  ]);
  expect(assistant?.parts).toEqual([
    { type: "thinking", text: "Check the parser first" },
    { type: "text", text: "Reading the parser now." },
    {
      type: "tool_call",
      toolKey: "call_CCCC3333",
      name: "read",
      input: { filePath: "/home/dev/projects/demo/parse.ts" },
    },
    {
      type: "tool_result",
      toolKey: "call_CCCC3333",
      output: "export const parseDate = () => null",
    },
    {
      type: "tool_call",
      toolKey: "call_DDDD4444",
      name: "mcp__linear__create_issue",
      input: { title: "Parser returns null" },
    },
    { type: "tool_result", toolKey: "call_DDDD4444", output: "rate limited", isError: true },
  ]);
  expect(conversation.toolExecutions).toEqual([
    {
      toolKey: "call_CCCC3333",
      messageKey: "msg_BBBB2222",
      name: "read",
      input: { filePath: "/home/dev/projects/demo/parse.ts" },
      output: "export const parseDate = () => null",
      status: "ok",
      startedAt: at(1789983315100),
      endedAt: at(1789983315200),
    },
    {
      toolKey: "call_DDDD4444",
      messageKey: "msg_BBBB2222",
      name: "mcp__linear__create_issue",
      input: { title: "Parser returns null" },
      output: "rate limited",
      status: "error",
      startedAt: at(1789983315300),
    },
  ]);
  expect(conversation.requests).toEqual([
    {
      requestKey: "msg_BBBB2222",
      messageKey: "msg_BBBB2222",
      modelRaw: "opencode-go/gpt-5.6-luna",
      routeHint: "opencode-go",
      requestedAt: at(1789983315000),
      usage: {
        inputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 2592,
        cacheWrite1hTokens: 0,
        outputTokens: 499,
        reasoningTokens: 432,
      },
      usageBasis: "reported",
      sourceRecordKey: "msg_BBBB2222",
    },
  ]);
});

test("v2 rows win over legacy rows carrying the same session id", () => {
  const collided = [
    ...v2Records,
    sqliteRow("session", { ...legacy.session, id: "ses_AAAA1111" }),
    sqliteRow("message", { ...legacy.assistantMessage, session_id: "ses_AAAA1111" }),
    ...legacy.parts.map((part) => sqliteRow("part", { ...part, session_id: "ses_AAAA1111" })),
  ];
  const conversation = normalized("ses_AAAA1111", collided);
  expect(conversation.messages.map((message) => message.messageKey)).toEqual([
    "msg_USER0001",
    "msg_BBBB2222",
    "msg_IDLE0003",
  ]);
  expect(conversation.requests.map((request) => request.requestKey)).toEqual(["msg_BBBB2222"]);
  expect(
    conversation.messages.some((message) => message.text.includes("Running the migration.")),
  ).toBe(false);
});

test("legacy messages join their part rows and price every step-finish", () => {
  const conversation = normalized("ses_EEEE5555", legacyRecords);
  expect(conversation.projectPath).toBe("/home/dev/projects/legacy");
  expect(conversation.messages.map((message) => [message.messageKey, message.role])).toEqual([
    ["msg_FFFF6666", "user"],
    ["msg_DDDD4444", "assistant"],
  ]);
  const assistant = conversation.messages[1];
  expect(assistant?.parentMessageKey).toBe("msg_FFFF6666");
  expect(assistant?.parts).toEqual([
    { type: "text", text: "Running the migration." },
    {
      type: "tool_call",
      toolKey: "call_HHHH8888",
      name: "bash",
      input: { command: "bun run migrate" },
    },
    { type: "tool_result", toolKey: "call_HHHH8888", output: "migrated 3 tables" },
  ]);
  expect(conversation.toolExecutions).toEqual([
    {
      toolKey: "call_HHHH8888",
      messageKey: "msg_DDDD4444",
      name: "bash",
      input: { command: "bun run migrate" },
      output: "migrated 3 tables",
      status: "ok",
      startedAt: at(1788554992000),
      endedAt: at(1788554993000),
    },
  ]);
  expect(
    conversation.requests.map((request) => [request.requestKey, request.modelRaw, request.usage]),
  ).toEqual([
    [
      "prt_0004",
      "github-copilot/claude-sonnet-4.5",
      {
        inputTokens: 500,
        cacheReadTokens: 10000,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 320,
        reasoningTokens: 120,
      },
    ],
    [
      "prt_0005",
      "github-copilot/claude-sonnet-4.5",
      {
        inputTokens: 342,
        cacheReadTokens: 4848,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 463,
        reasoningTokens: 200,
      },
    ],
  ]);
});

test("file store documents normalize on their own", () => {
  const conversation = normalized("ses_IIII9999", [
    jsonDocument("storage/session/prj_3333/ses_IIII9999.json", store.session),
    jsonDocument("storage/message/ses_IIII9999/msg_JJJJ0000.json", store.message),
    jsonDocument("storage/part/msg_JJJJ0000/prt_KKKK1111.json", store.part),
  ]);
  expect(conversation.title).toBe("File store run");
  expect(conversation.projectPath).toBe("/home/dev/projects/archive");
  expect(conversation.clientVersion).toBe("1.1.36");
  expect(
    conversation.messages.map((message) => [message.messageKey, message.role, message.text]),
  ).toEqual([["msg_JJJJ0000", "assistant", "Archived answer."]]);
  expect(
    conversation.requests.map((request) => [
      request.requestKey,
      request.modelRaw,
      request.usage.outputTokens,
    ]),
  ).toEqual([["msg_JJJJ0000", "openai/gpt-4.1", 50]]);
});

test("the same rows seen from two machines collapse to the latest version", () => {
  const stale = {
    ...v2.assistant,
    time_updated: 1789983314900,
    data: {
      ...v2.assistant.data,
      tokens: { input: 3, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  };
  const conversation = normalized("ses_AAAA1111", [
    sqliteRow("session_v2", v2.session_v2),
    sqliteRow("session_message", v2.assistant),
    sqliteRow("session_v2", v2.session_v2, {
      root: machineB,
      observedAt: "2026-09-20T11:00:00.000Z",
    }),
    sqliteRow("session_message", stale, { root: machineB, observedAt: "2026-09-20T11:00:00.000Z" }),
  ]);
  expect(conversation.messages.map((message) => message.messageKey)).toEqual(["msg_BBBB2222"]);
  expect(conversation.toolExecutions.map((tool) => tool.toolKey)).toEqual([
    "call_CCCC3333",
    "call_DDDD4444",
  ]);
  expect(conversation.requests.map((request) => request.usage.outputTokens)).toEqual([499]);
});

test("a base64 data column decodes and unreadable rows are skipped", () => {
  const conversation = normalized("ses_AAAA1111", [
    sqliteRow("session_v2", v2.session_v2),
    sqliteRow("session_message", v2.assistant, { blob: true }),
    { ...sqliteRow("session_message", v2.user), payload: "{not json" },
    sqliteRow("session_message", {
      id: "msg_BAD0002",
      session_id: "ses_AAAA1111",
      type: "assistant",
      data: "@@@",
    }),
  ]);
  expect(conversation.messages.map((message) => message.messageKey)).toEqual(["msg_BBBB2222"]);
  expect(conversation.requests.map((request) => request.usage.outputTokens)).toEqual([499]);
});

test("a child session records its parent", () => {
  const conversation = normalized("ses_CHILD001", [
    sqliteRow("session_v2", { ...v2.session_v2, id: "ses_CHILD001", parent_id: "ses_AAAA1111" }),
    sqliteRow("session_message", {
      ...v2.assistant,
      id: "msg_CHILD002",
      session_id: "ses_CHILD001",
    }),
  ]);
  expect(conversation.conversationKey).toBe("ses_CHILD001");
  expect(conversation.parentConversationKey).toBe("ses_AAAA1111");
  expect(conversation.messages.map((message) => message.messageKey)).toEqual(["msg_CHILD002"]);
});

test("session rollups only stand in when no message reports usage", () => {
  const conversation = normalized("ses_AAAA1111", [sqliteRow("session_v2", v2.session_v2)]);
  expect(conversation.messages).toEqual([]);
  expect(conversation.requests).toEqual([
    {
      requestKey: "session-level",
      modelRaw: "opencode-go/gpt-5.6-luna",
      routeHint: "opencode-go",
      requestedAt: at(1789983314397),
      usage: {
        inputTokens: 6,
        cacheReadTokens: 0,
        cacheWriteTokens: 4314,
        cacheWrite1hTokens: 0,
        outputTokens: 512,
        reasoningTokens: 432,
      },
      usageBasis: "estimated",
      sourceRecordKey: "ses_AAAA1111",
    },
  ]);
  expect(
    normalized("ses_AAAA1111", v2Records).requests.map((request) => request.requestKey),
  ).toEqual(["msg_BBBB2222"]);
  const empty = {
    ...v2.session_v2,
    cost: 0,
    tokens_input: 0,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
  };
  expect(opencodeNormalizer.normalize("ses_AAAA1111", [sqliteRow("session_v2", empty)])).toBeNull();
});

test("a message without timestamps falls back to when the agent saw its row", () => {
  const untimed = {
    id: "msg_USER0001",
    session_id: "ses_AAAA1111",
    type: "user",
    seq: 4,
    data: { text: "Fix the date parser" },
  };
  const conversation = normalized("ses_AAAA1111", [sqliteRow("session_message", untimed)]);
  expect(conversation.messages.map((message) => message.createdAt)).toEqual([
    "2026-09-20T10:00:00.000Z",
  ]);
  expect(conversation.startedAt).toBe("2026-09-20T10:00:00.000Z");
});

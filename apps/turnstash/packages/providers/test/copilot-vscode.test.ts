import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { streamIdOf, type JsonFileSource, type SourceRecordRow } from "@aqt/turnstash-core";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Option } from "effect";

import { copilotNormalizer, copilotSource } from "../src/copilot/index.ts";
import { readVscodeChat } from "../src/copilot/vscode.ts";

const request = {
  requestId: "request-1",
  message: { text: "Explain this function" },
  timestamp: Date.parse("2026-06-01T10:01:00Z"),
  modelId: "copilot/claude-haiku-4.5",
  agent: { extensionId: { value: "GitHub.copilot-chat" }, extensionVersion: "0.35.2" },
  response: [
    { kind: "thinking", value: "I should read the function." },
    {
      kind: "toolInvocationSerialized",
      toolCallId: "call-1",
      toolId: "copilot_readFile",
      invocationMessage: { value: "Reading main.ts" },
      isComplete: true,
    },
    { value: "The function returns a greeting." },
  ],
};
const session = {
  sessionId: "session-1",
  creationDate: Date.parse("2026-06-01T10:00:00Z"),
  lastMessageDate: Date.parse("2026-06-01T10:02:00Z"),
  responderUsername: "GitHub Copilot",
  customTitle: "Explain the greeting",
  requests: [request],
};

const withChat = async (
  name: string,
  content: string,
  check: (source: JsonFileSource) => Promise<void>,
) => {
  const directory = await mkdtemp(join(tmpdir(), "turnstash-vscode-"));
  try {
    const root = { path: directory, label: "copilot-vscode-chats" };
    await Bun.write(
      join(directory, "workspace", "workspace.json"),
      JSON.stringify({ folder: "file:///work/demo" }),
    );
    await Bun.write(join(directory, "workspace", "chatSessions", name), content);
    await check({ kind: "json", root, relativePath: `workspace/chatSessions/${name}` });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const read = async (source: JsonFileSource): Promise<ReadonlyArray<SourceRecordRow>> => {
  const records = await Effect.runPromise(
    readVscodeChat(streamIdOf(source), join(source.root.path, source.relativePath)).pipe(
      Effect.provide(BunServices.layer),
    ),
  );
  return records.map((record) => ({ ...record, observedAt: "2026-06-02T10:00:00.000Z" }));
};

test("discovers saved chats without importing editor state or unrelated files", () =>
  withChat("session-1.json", JSON.stringify(session), async (source) => {
    await Bun.write(
      join(source.root.path, "workspace", "chatEditingSessions", "session-1", "state.json"),
      "{}",
    );
    await Bun.write(join(source.root.path, "workspace", "other.json"), "{}");
    await mkdir(join(source.root.path, "workspace", "chatSessions", "nested"));
    await Bun.write(
      join(source.root.path, "workspace", "chatSessions", "nested", "ignored.json"),
      "{}",
    );
    await Bun.write(join(source.root.path, "workspace", "chatSessions", "session-2.jsonl"), "{}");
    const descriptors = await Effect.runPromise(
      copilotSource.discover(source.root).pipe(Effect.provide(BunServices.layer)),
    );
    expect(descriptors.map((descriptor) => descriptor.relativePath)).toEqual([
      "workspace/chatSessions/session-1.json",
      "workspace/chatSessions/session-2.jsonl",
    ]);
    expect(
      descriptors.every(
        (descriptor) => descriptor.kind === "json" && descriptor.readRecords === readVscodeChat,
      ),
    ).toBe(true);
  }));

test("extracts large saved snapshots into small turns and preserves the transcript", () =>
  withChat(
    "session-1.json",
    JSON.stringify({
      ...session,
      requests: [
        { ...request, result: { metadata: { renderedUserMessage: "x".repeat(9 * 1024 * 1024) } } },
      ],
    }),
    async (source) => {
      const records = await read(source);
      expect(records).toHaveLength(2);
      expect(records.every((record) => record.payload.length < 2000)).toBe(true);
      expect(
        Option.getOrNull(
          copilotNormalizer.conversationKeyOf(streamIdOf(source), records[0]?.payload ?? ""),
        ),
      ).toBe("vscode:session-1");
      const conversation = copilotNormalizer.normalize("vscode:session-1", records);
      expect(conversation?.title).toBe("Explain the greeting");
      expect(conversation?.projectPath).toBe("file:///work/demo");
      expect(conversation?.clientVersion).toBe("0.35.2");
      expect(conversation?.startedAt).toBe("2026-06-01T10:00:00.000Z");
      expect(conversation?.endedAt).toBe("2026-06-01T10:02:00.000Z");
      expect(conversation?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(conversation?.messages[0]?.text).toBe(request.message.text);
      expect(conversation?.messages[1]?.parts).toContainEqual({
        type: "text",
        text: "The function returns a greeting.",
      });
      expect(conversation?.messages[1]?.parts).toContainEqual({
        type: "thinking",
        text: "I should read the function.",
      });
      expect(conversation?.toolExecutions[0]?.name).toBe("copilot_readFile");
      expect(conversation?.requests).toEqual([]);
    },
  ));

test("replays JSONL initial state, nested replacements and array appends", () => {
  const journal =
    [
      { kind: 0, v: { ...session, requests: [] } },
      { kind: 2, k: "requests", v: [{ ...request, response: [] }] },
      { kind: 1, k: ["requests", 0, "message", "text"], v: "Updated question" },
      { kind: 2, k: ["requests", 0, "response"], v: request.response },
      {
        kind: 2,
        k: ["requests", 0, "response"],
        i: 2,
        v: [
          { value: "Updated answer after rewind." },
          { kind: "textEditGroup", value: { edits: [{ text: "editor content" }] } },
        ],
      },
      { kind: 2, k: ["requests", 0, "response"], i: 3 },
      { kind: 1, k: ["requests", 0, "temporary"], v: true },
      { kind: 1, k: ["requests", 0, "temporary"] },
      { kind: 1, k: ["customTitle"], v: "Temporary title" },
      { kind: 3, k: ["customTitle"] },
      { kind: 1, k: ["customTitle"], v: "Updated title" },
    ]
      .map((op) => JSON.stringify(op))
      .join("\n") + "\n";
  return withChat("session-1.jsonl", journal, async (source) => {
    const records = await read(source);
    const conversation = copilotNormalizer.normalize("vscode:session-1", records);
    expect(conversation?.title).toBe("Updated title");
    expect(conversation?.messages[0]?.text).toBe("Updated question");
    expect(conversation?.messages[1]?.text).toContain("Updated answer after rewind.");
    const emptyHeader = records[0];
    if (emptyHeader === undefined) throw new Error("expected header");
    expect(
      copilotNormalizer.normalize("vscode:session-1", [
        ...records,
        {
          ...emptyHeader,
          payload: JSON.stringify({ ...session, type: "vscode.session", requestIds: [] }),
          observedAt: "2026-06-03T10:00:00.000Z",
        },
      ]),
    ).toBeNull();
  });
});

test("ignores empty sessions and other chat extensions", async () => {
  await withChat("empty.json", JSON.stringify({ ...session, requests: [] }), async (source) => {
    expect(copilotNormalizer.normalize("vscode:empty", await read(source))).toBeNull();
  });
  await withChat(
    "other.json",
    JSON.stringify({
      ...session,
      responderUsername: "Other assistant",
      requests: [{ ...request, agent: { extensionId: "other.chat" } }],
    }),
    async (source) => {
      expect(await read(source)).toEqual([]);
    },
  );
});

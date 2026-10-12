import { expect, test } from "bun:test";

import {
  emptyUsage,
  type NormalizedConversation,
  type NormalizedMessage,
} from "@aqt/turnstash-core";

import { analyzeConversation } from "../src/turns.ts";

const at = (second: number) => `2026-09-21T09:00:${String(second).padStart(2, "0")}.000Z`;
const message = (
  seq: number,
  role: NormalizedMessage["role"],
  parts: NormalizedMessage["parts"],
  text = "",
): NormalizedMessage => ({
  messageKey: `m${seq}`,
  seq,
  role,
  createdAt: at(seq),
  parts,
  text,
});
const request = (requestKey: string, requestedAt: string, messageKey?: string) => ({
  requestKey,
  modelRaw: "claude-opus-5",
  requestedAt,
  usage: emptyUsage,
  usageBasis: "reported" as const,
  ...(messageKey === undefined ? {} : { messageKey }),
});

const conversation: NormalizedConversation = {
  conversationKey: "c",
  startedAt: at(0),
  endedAt: at(9),
  toolExecutions: [],
  messages: [
    message(0, "user", [{ type: "text", text: "add a login page" }], "add a login page"),
    message(1, "assistant", [
      { type: "tool_call", toolKey: "t1", name: "Edit", input: { file_path: "login.tsx" } },
      {
        type: "tool_call",
        toolKey: "t2",
        name: "Bash",
        input: { command: "bun test && git status" },
      },
      { type: "tool_call", toolKey: "t3", name: "mcp__linear__create_issue", input: {} },
    ]),
    message(2, "tool", [{ type: "tool_result", toolKey: "t1", output: "ok" }], "ok"),
    message(3, "user", [{ type: "tool_result", toolKey: "t2", output: "ok" }], "ok"),
    message(4, "assistant", [
      { type: "tool_call", toolKey: "t4", name: "Skill", input: { skill: "review" } },
    ]),
    message(
      5,
      "user",
      [{ type: "text", text: "why does the test fail?" }],
      "why does the test fail?",
    ),
    message(6, "assistant", [
      { type: "tool_call", toolKey: "t5", name: "Read", input: { file_path: "login.tsx" } },
    ]),
  ],
  requests: [
    request("r1", at(1), "m1"),
    request("r2", at(4), "m4"),
    request("r3", at(7)),
    request("r4", at(6), "m6"),
  ],
};

test("turns start at user text, absorb tool results, and own their requests by message or by time", () => {
  const analysis = analyzeConversation(conversation);
  expect(analysis.turns.map((turn) => turn.category)).toEqual(["feature", "exploration"]);
  expect(analysis.turns[0]).toMatchObject({
    firstSeq: 0,
    userExcerpt: "add a login page",
    tools: ["Edit", "Bash", "mcp__linear__create_issue", "Skill"],
    skills: ["review"],
    skill: "review",
    mcpServers: ["linear"],
    commands: ["bun", "git"],
    edits: 1,
    requestKeys: ["r1", "r2"],
  });
  expect(analysis.turns[1]?.requestKeys).toEqual(["r4", "r3"]);
  expect([...analysis.turnOfRequest.entries()]).toEqual([
    ["r1", 0],
    ["r2", 0],
    ["r4", 1],
    ["r3", 1],
  ]);
  expect([...analysis.turnOfMessage.entries()]).toEqual([
    ["m0", 0],
    ["m1", 0],
    ["m2", 0],
    ["m3", 0],
    ["m4", 0],
    ["m5", 1],
    ["m6", 1],
  ]);
});

test("Codex command arrays retain argument boundaries between edits", () => {
  const analysis = analyzeConversation({
    ...conversation,
    requests: [],
    messages: [
      message(0, "user", [{ type: "text", text: "edit the file" }], "edit the file"),
      message(1, "assistant", [
        {
          type: "tool_call",
          toolKey: "edit1",
          name: "edit",
          input: { path: "src/a.ts" },
        },
        {
          type: "tool_call",
          toolKey: "read",
          name: "shell",
          input: { command: ["bash", "-lc", "sed -n '1,2p' src/a.ts"] },
        },
        {
          type: "tool_call",
          toolKey: "edit2",
          name: "edit",
          input: { path: "src/a.ts" },
        },
        {
          type: "tool_call",
          toolKey: "check",
          name: "shell",
          input: { command: ["bash", "-lc", "bun test && git status"] },
        },
        {
          type: "tool_call",
          toolKey: "edit3",
          name: "edit",
          input: { path: "src/a.ts" },
        },
      ]),
    ],
  });
  expect(analysis.turns[0]).toMatchObject({
    commands: ["sed", "bun", "git"],
    edits: 3,
    retries: 1,
  });
});

test("subagent threads fold into the spawning turn, repeated prompts merge, and patches name their file", () => {
  const spawned: NormalizedConversation = {
    ...conversation,
    messages: [
      message(
        0,
        "user",
        [{ type: "text", text: "<command-name>/clear</command-name>" }],
        "<command-name>/clear</command-name>",
      ),
      message(1, "user", [{ type: "text", text: "delegate the search" }], "delegate the search"),
      {
        ...message(2, "assistant", [
          { type: "tool_call", toolKey: "a1", name: "Agent", input: { prompt: "find it" } },
        ]),
        parentMessageKey: "m1",
      },
      {
        ...message(3, "user", [{ type: "tool_result", toolKey: "a1", output: "done" }], "done"),
        parentMessageKey: "m2",
      },
      {
        ...message(4, "user", [{ type: "text", text: "find it" }], "find it"),
        parentMessageKey: "m2",
      },
      {
        ...message(5, "assistant", [
          {
            type: "tool_call",
            toolKey: "p1",
            name: "apply_patch",
            input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** End Patch",
          },
        ]),
        parentMessageKey: "m4",
      },
      {
        ...message(6, "assistant", [
          { type: "tool_call", toolKey: "s1", name: "shell", input: { command: ["bun", "test"] } },
        ]),
        parentMessageKey: "m5",
      },
      {
        ...message(7, "assistant", [
          {
            type: "tool_call",
            toolKey: "p2",
            name: "apply_patch",
            input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** End Patch",
          },
        ]),
        parentMessageKey: "m6",
      },
      {
        ...message(8, "user", [{ type: "text", text: "now ship it" }], "now ship it"),
        parentMessageKey: "m3",
      },
    ],
    requests: [request("r1", at(2), "m2"), request("r2", at(5), "m5"), request("r3", at(8), "m8")],
  };
  const analysis = analyzeConversation(spawned);
  expect(analysis.turns.map((turn) => [turn.userExcerpt, turn.category, turn.requestKeys])).toEqual(
    [
      ["delegate the search", "delegation", ["r1", "r2"]],
      ["now ship it", "conversation", ["r3"]],
    ],
  );
  expect(analysis.turns[0]).toMatchObject({
    firstSeq: 0,
    edits: 2,
    retries: 1,
    commands: ["bun"],
    tools: ["Agent", "apply_patch", "shell"],
  });
});

import type { MessageView, TurnView } from "@aqt/turnstash-api";
import { Match } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";

import { Markdown } from "../src/components/MessagePartView";
import { type Block, toolOutcomes, toolSummary, transcriptBlocks } from "../src/transcript";

const messageView = (
  messageKey: string,
  role: MessageView["role"],
  parts: MessageView["parts"],
): MessageView => ({
  id: `00000000-0000-4000-8000-${messageKey.padStart(12, "0")}`,
  messageKey,
  seq: Number(messageKey),
  role,
  parentMessageKey: null,
  createdAt: "2026-10-16T10:00:00.000Z",
  parts,
  requests: [],
});

const turnView = (turnIndex: number, messageKey: string): TurnView => ({
  turnIndex,
  messageKey,
  startedAt: "2026-10-16T10:00:00.000Z",
  userExcerpt: "",
  category: "coding",
  skill: null,
  primaryModelId: null,
  tools: [],
  commands: [],
  edits: 0,
  retries: 0,
  requests: 0,
  costUsd: 0,
});

test("tool calls across an agent loop form one run beside their results, and turns head their prompt", () => {
  const messages = [
    messageView("1", "user", [{ type: "text", text: "fix the build" }]),
    messageView("2", "assistant", [
      { type: "text", text: "Looking." },
      { type: "tool_call", toolKey: "a", name: "Bash", input: { command: "bun test" } },
    ]),
    messageView("3", "user", [
      { type: "tool_result", toolKey: "a", output: "1 fail", isError: true },
    ]),
    messageView("4", "assistant", [
      { type: "tool_call", toolKey: "b", name: "Edit", input: { file_path: "src/a.ts" } },
    ]),
    messageView("5", "user", [{ type: "tool_result", toolKey: "b", output: "ok" }]),
    messageView("6", "assistant", [{ type: "text", text: "Fixed." }]),
    messageView("7", "user", [{ type: "text", text: "thanks" }]),
  ];
  const blocks = transcriptBlocks(messages, [turnView(0, "1"), turnView(1, "7")]);
  expect(
    blocks.map(
      Match.type<Block>().pipe(
        Match.discriminatorsExhaustive("kind")({
          turn: ({ turn }) => `turn ${turn.turnIndex}`,
          message: ({ message }) => message.messageKey,
          tools: ({ steps }) =>
            steps.map((step) => `${step.call.name}:${step.resultKey}`).join(","),
        }),
      ),
    ),
  ).toEqual(["turn 0", "1", "2", "Bash:3,Edit:5", "6", "turn 1", "7"]);
  const outcomes = toolOutcomes(messages, []);
  expect(outcomes.get("a")).toEqual({ output: "1 fail", failed: true, known: true });
  expect(outcomes.get("b")?.failed).toBe(false);
});

test("tool summaries name the command or file and drop the shell wrapper", () => {
  expect(toolSummary({ command: ["bash", "-lc", "rg foo src"] })).toBe("rg foo src");
  expect(toolSummary({ file_path: "src/a.ts", content: "x" })).toBe("src/a.ts");
  expect(
    toolSummary("*** Begin Patch\n*** Update File: a.ts\n@@\n*** Add File: b.ts\n*** End Patch"),
  ).toBe("a.ts, b.ts");
  expect(toolSummary({ unrelated: 1 })).toBe("");
});

test("assistant markdown never renders raw HTML, images or script links", () => {
  const html = renderToStaticMarkup(
    <Markdown
      text={
        "**bold** <script>alert(1)</script> ![x](https://tracker.example/p.png) [a](javascript:alert(1))"
      }
    />,
  );
  expect(html).toContain("<strong>bold</strong>");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("javascript:");
});

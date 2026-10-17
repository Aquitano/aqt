import type { MessageView, RequestSummary, ToolExecutionView, TurnView } from "@aqt/turnstash-api";
import { Match, Predicate, type Schema } from "effect";

export type Part = MessageView["parts"][number];
export type ToolCall = Extract<Part, { type: "tool_call" }>;
export type ContentPart = Exclude<Part, { type: "tool_call" | "tool_result" }>;

export interface ToolStep {
  readonly call: ToolCall;
  readonly messageKey: string;
  readonly resultKey: string | undefined;
}

export interface ToolOutcome {
  readonly output: string | null;
  readonly failed: boolean;
  readonly known: boolean;
}

export type Block =
  | { readonly kind: "turn"; readonly key: string; readonly turn: TurnView }
  | {
      readonly kind: "message";
      readonly key: string;
      readonly message: MessageView;
      readonly parts: ReadonlyArray<ContentPart>;
      readonly requests: ReadonlyArray<RequestSummary>;
    }
  | {
      readonly kind: "tools";
      readonly key: string;
      readonly steps: ReadonlyArray<ToolStep>;
      readonly requests: ReadonlyArray<RequestSummary>;
    };

export const blockMessageKeys = Match.type<Block>().pipe(
  Match.discriminatorsExhaustive("kind")({
    turn: ({ turn }): ReadonlyArray<string> => (turn.messageKey === null ? [] : [turn.messageKey]),
    message: ({ message }) => [message.messageKey],
    tools: ({ steps }) =>
      steps.flatMap((step) =>
        step.resultKey === undefined ? [step.messageKey] : [step.messageKey, step.resultKey],
      ),
  }),
);

// Agent loops alternate an assistant message holding tool calls with a message holding their results.
// Calls from consecutive messages form one run until text appears, and results render beside their call.
export const transcriptBlocks = (
  messages: ReadonlyArray<MessageView>,
  turns: ReadonlyArray<TurnView>,
): ReadonlyArray<Block> => {
  const turnStarts = new Map(
    turns.flatMap((turn) => (turn.messageKey === null ? [] : [[turn.messageKey, turn] as const])),
  );
  const resultKeys = new Map(
    messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "tool_result" ? [[part.toolKey, message.messageKey] as const] : [],
      ),
    ),
  );
  const blocks: Array<Block> = [];
  let run: { steps: Array<ToolStep>; requests: Array<RequestSummary> } | null = null;
  const closeRun = () => {
    const first = run?.steps[0];
    if (run !== null && first !== undefined)
      blocks.push({
        kind: "tools",
        key: `tools:${first.call.toolKey}`,
        steps: run.steps,
        requests: run.requests,
      });
    run = null;
  };

  for (const message of messages) {
    const turn = turnStarts.get(message.messageKey);
    if (turn !== undefined) {
      closeRun();
      blocks.push({ kind: "turn", key: `turn:${turn.turnIndex}`, turn });
    }
    let segment: Array<ContentPart> = [];
    let segments = 0;
    let requests = message.requests;
    const closeSegment = () => {
      if (segment.length === 0) return;
      blocks.push({
        kind: "message",
        key: `${message.id}:${segments}`,
        message,
        parts: segment,
        requests,
      });
      segments += 1;
      requests = [];
      segment = [];
    };
    for (const part of message.parts) {
      if (part.type === "tool_result") continue;
      if (part.type === "tool_call") {
        closeSegment();
        run ??= { steps: [], requests: [] };
        run.steps.push({
          call: part,
          messageKey: message.messageKey,
          resultKey: resultKeys.get(part.toolKey),
        });
        continue;
      }
      closeRun();
      segment.push(part);
    }
    closeSegment();
    if (requests.length > 0) run?.requests.push(...requests);
  }
  closeRun();
  return blocks;
};

export const toolOutcomes = (
  messages: ReadonlyArray<MessageView>,
  executions: ReadonlyArray<ToolExecutionView>,
): ReadonlyMap<string, ToolOutcome> => {
  const outcomes = new Map<string, ToolOutcome>(
    executions.map((execution) => [
      execution.toolKey,
      {
        output: execution.output,
        failed: execution.status === "error",
        known: execution.status !== "unknown",
      },
    ]),
  );
  for (const message of messages)
    for (const part of message.parts) {
      if (part.type !== "tool_result") continue;
      const execution = outcomes.get(part.toolKey);
      outcomes.set(part.toolKey, {
        output: part.output ?? execution?.output ?? null,
        failed: part.isError === true || execution?.failed === true,
        known: part.isError !== undefined || execution?.known === true,
      });
    }
  return outcomes;
};

const injectedTag = /^<([a-z][\w-]*)>[\s\S]*<\/[a-z][\w-]*>$/;
const commandName = /<command-name>([\s\S]*?)<\/command-name>/;
const commandArgs = /<command-args>([\s\S]*?)<\/command-args>/;

// Agents file slash commands, hook output and local command caveats as user messages wrapped in
// tags. They are named by their command or tag so they do not read as something the user typed.
export const injectedLabel = (text: string): string | null => {
  const trimmed = text.trim();
  const tag = injectedTag.exec(trimmed)?.[1];
  if (tag === undefined) return null;
  const command = commandName.exec(trimmed)?.[1]?.trim();
  if (command === undefined) return tag.replaceAll("-", " ");
  const args = commandArgs.exec(trimmed)?.[1]?.trim() ?? "";
  return args === "" ? command : `${command} ${args}`;
};

const summaryFields = [
  "command",
  "cmd",
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "target_file",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
  "skill",
] as const;

const shellWrapper = /^(?:ba|z|da)?sh$|^pwsh$|^powershell$/;

const argv = (args: ReadonlyArray<string>): string => {
  const [shell, flag, ...rest] = args;
  return shell !== undefined && shellWrapper.test(shell) && flag?.startsWith("-") === true
    ? rest.join(" ")
    : args.join(" ");
};

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const patchFile = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;

// A patch's first line is always its envelope, so a patch is summarized by the files it touches.
const firstLine = (text: string): string => {
  const files = [...text.matchAll(patchFile)].map((match) => match[1]?.trim());
  return files.length > 0 ? files.join(", ") : (text.trim().split("\n", 1)[0] ?? "");
};

// One line that says what a tool call did, from the input fields agents commonly use.
export const toolSummary = (input: Schema.Json): string => {
  if (Predicate.isString(input)) return firstLine(input);
  if (!isJsonObject(input)) return "";
  for (const field of summaryFields) {
    const value = input[field];
    if (Predicate.isString(value) && value.trim() !== "") return firstLine(value);
    if (Array.isArray(value) && value.length > 0 && value.every(Predicate.isString))
      return firstLine(argv(value));
  }
  return "";
};

import type { MessageView, RequestSummary, ToolExecutionView, TurnView } from "@aqt/turnstash-api";
import { Match, Predicate, type Schema } from "effect";

export type Part = MessageView["parts"][number];
export type ToolCall = Extract<Part, { type: "tool_call" }>;
export type ContentPart = Exclude<Part, { type: "tool_call" | "tool_result" }>;

export interface ToolStep {
  readonly kind: "tool";
  readonly toolKey: string;
  // Undefined for a result whose call is missing from the archive or on a page not loaded yet.
  readonly call: ToolCall | undefined;
  readonly messageKey: string;
  readonly resultKey: string | undefined;
}

export interface PartStep {
  readonly kind: "part";
  readonly key: string;
  readonly part: ContentPart;
  readonly messageKey: string;
}

export type Step = ToolStep | PartStep;

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
      readonly steps: ReadonlyArray<Step>;
      readonly requests: ReadonlyArray<RequestSummary>;
    };

export type MessageKeys = readonly [string, ...ReadonlyArray<string>];

export const blockMessageKeys = Match.type<Block>().pipe(
  Match.discriminatorsExhaustive("kind")({
    turn: ({ turn }): ReadonlyArray<string> => (turn.messageKey === null ? [] : [turn.messageKey]),
    message: ({ message }) => [message.messageKey],
    tools: ({ steps }) =>
      steps.flatMap((step) =>
        step.kind === "part" || step.resultKey === undefined
          ? [step.messageKey]
          : [step.messageKey, step.resultKey],
      ),
  }),
);

export const isLinked = (step: Step, linkedKey: string | undefined): boolean =>
  linkedKey !== undefined &&
  (step.messageKey === linkedKey || (step.kind === "tool" && step.resultKey === linkedKey));

// Agent loops alternate an assistant message holding tool calls with a message holding their results.
// Calls from consecutive messages form one run until text appears, and results render beside their call.
// Thinking and other parts between calls stay in the run, and a result without a loaded call is a step.
// The first linked step starts a run of its own, so a link scrolls to it rather than to a long run's start.
export const transcriptBlocks = (
  messages: ReadonlyArray<MessageView>,
  turns: ReadonlyArray<TurnView>,
  linkedKey?: string,
): ReadonlyArray<Block> => {
  const turnStarts = new Map(
    turns.flatMap((turn) => (turn.messageKey === null ? [] : [[turn.messageKey, turn] as const])),
  );
  const calls = new Set(
    messages.flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "tool_call" ? [part.toolKey] : [])),
    ),
  );
  const resultKeys = new Map(
    messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "tool_result" ? [[part.toolKey, message.messageKey] as const] : [],
      ),
    ),
  );
  const blocks: Array<Block> = [];
  let run: { steps: Array<Step>; requests: Array<RequestSummary> } | null = null;
  const closeRun = () => {
    const first = run?.steps[0];
    if (run !== null && first !== undefined)
      blocks.push({
        kind: "tools",
        key: `tools:${first.kind === "tool" ? first.toolKey : first.key}`,
        steps: run.steps,
        requests: run.requests,
      });
    run = null;
  };
  let linkSeen = false;

  for (const message of messages) {
    const turn = turnStarts.get(message.messageKey);
    if (turn !== undefined) {
      closeRun();
      blocks.push({ kind: "turn", key: `turn:${turn.turnIndex}`, turn });
    }
    let segment: Array<ContentPart> = [];
    let segments = 0;
    let requests = message.requests;
    const pushSegment = () => {
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
    for (const [index, part] of message.parts.entries()) {
      let step: Step;
      if (part.type === "tool_call" || part.type === "tool_result") {
        if (part.type === "tool_result" && calls.has(part.toolKey)) continue;
        step = {
          kind: "tool",
          toolKey: part.toolKey,
          call: part.type === "tool_call" ? part : undefined,
          messageKey: message.messageKey,
          resultKey: part.type === "tool_call" ? resultKeys.get(part.toolKey) : undefined,
        };
      } else if (run !== null && part.type !== "text") {
        step = {
          kind: "part",
          key: `${message.id}:${index}`,
          part,
          messageKey: message.messageKey,
        };
      } else {
        closeRun();
        segment.push(part);
        continue;
      }
      if (segment.length > 0) pushSegment();
      if (!linkSeen && isLinked(step, linkedKey)) {
        linkSeen = true;
        closeRun();
      }
      run ??= { steps: [], requests: [] };
      run.steps.push(step);
    }
    if (segment.length > 0) pushSegment();
    if (requests.length === 0) continue;
    if (run === null) pushSegment();
    else run.requests.push(...requests);
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

const injectedTag =
  /^<(bash-input|bash-stdout|command-message|command-name|fork-boilerplate|local-command-caveat|local-command-stdout|new-diagnostics|system-reminder|task-notification)>[\s\S]*<\/[a-z-]+>$/;
const commandName = /<command-name>([\s\S]*?)<\/command-name>/;
const commandArgs = /<command-args>([\s\S]*?)<\/command-args>/;

// Claude Code files slash commands, their output, shell-mode commands, reminders and background task
// notices as user messages wrapped in these tags. They are named by their command or tag so they do
// not read as something the user typed; any other tag is the user's own.
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

import { fileURLToPath } from "node:url";

import {
  isoTimestampOf as isoOf,
  emptyUsage,
  type MessagePart,
  type NormalizedConversation,
  type NormalizedMessage,
  type NormalizedRequest,
  type NormalizedToolExecution,
  type Normalizer,
  textOfParts,
} from "@aqt/turnstash-core";
import { Option, Schema } from "effect";

import {
  field,
  packedVarints,
  parseFields,
  positiveIntOf,
  subfields,
  textOf,
  timestampOf,
} from "./proto.ts";

const conversationOfStream = /\/(?:conversations\/([^/#]+)\.db#|brain\/([^/]+)\/)/;

const TranscriptStep = Schema.Struct({
  step_index: Schema.Int,
  type: Schema.String,
  source: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  created_at: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(Schema.String),
});
type TranscriptStep = typeof TranscriptStep.Type;
const decodeStep = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptStep));

const UsageRow = Schema.Struct({ idx: Schema.Int, data: Schema.String });
const decodeUsageRow = Schema.decodeUnknownOption(Schema.fromJsonString(UsageRow));

const toolTypes: Readonly<Record<string, string>> = {
  RUN_COMMAND: "run_command",
  CODE_ACTION: "code_action",
  VIEW_FILE: "view_file",
  LIST_DIRECTORY: "list_directory",
  GREP_SEARCH: "grep_search",
  FIND: "find",
  INVOKE_SUBAGENT: "invoke_subagent",
  GENERIC: "generic",
  CALL_MCP_TOOL: "call_mcp_tool",
  BROWSER: "browser",
};

const placeholderModel = /^MODEL_PLACEHOLDER_/;

const canonicalModel = (raw: string, displayName: string | undefined): string => {
  const lower = displayName?.toLowerCase() ?? "";
  const tier = lower.includes("high")
    ? "-high"
    : lower.includes("medium")
      ? "-medium"
      : lower.includes("low")
        ? "-low"
        : "";
  if (lower.includes("3.5 flash")) return `gemini-3.5-flash${tier}`;
  if (lower.includes("3.1 pro")) return `gemini-3.1-pro${tier === "-medium" ? "" : tier}`;
  if (lower.includes("3.1 flash"))
    return lower.includes("image")
      ? "gemini-3.1-flash-image"
      : lower.includes("lite")
        ? "gemini-3.1-flash-lite"
        : "gemini-3.1-flash";
  if (lower.includes("3 flash")) return "gemini-3-flash";
  if (lower.includes("3 pro")) return "gemini-3-pro";
  return placeholderModel.test(raw) ? "unknown" : raw;
};

interface UsageEntry {
  readonly requestKey: string;
  readonly modelRaw: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly createdAt: string | undefined;
  readonly steps: ReadonlyArray<number>;
}

const decodeUsage = (idx: number, data: Uint8Array): UsageEntry | null => {
  const root = parseFields(data);
  const chat = subfields(field(root, 1));
  const usage = subfields(field(chat, 4));
  if (usage.length === 0) return null;
  const inputTokens = positiveIntOf(field(usage, 2)) || positiveIntOf(field(usage, 1));
  const thinking = positiveIntOf(field(usage, 10));
  const outputTokens = positiveIntOf(field(usage, 3)) || positiveIntOf(field(usage, 9)) + thinking;
  if (inputTokens === 0 && outputTokens === 0) return null;
  const responseId = textOf(field(usage, 11));
  const attributes = new Map(
    chat
      .filter((entry) => entry.number === 20)
      .flatMap((entry) => {
        const pair = subfields(entry);
        const key = textOf(field(pair, 1));
        const value = textOf(field(pair, 2));
        return key === undefined || value === undefined ? [] : [[key, value] as const];
      }),
  );
  const displayName = textOf(field(chat, 21));
  const raw = textOf(field(chat, 19)) ?? attributes.get("model_enum") ?? displayName ?? "unknown";
  return {
    requestKey: responseId !== undefined && /^\S+$/.test(responseId) ? responseId : `idx:${idx}`,
    modelRaw: canonicalModel(raw, displayName),
    inputTokens,
    outputTokens,
    reasoningTokens: Math.min(thinking, outputTokens),
    createdAt: timestampOf(field(subfields(field(chat, 9)), 4)),
    steps: root.filter((entry) => entry.number === 2).flatMap(packedVarints),
  };
};

const bytesOfBase64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "base64"));

// The generic step "You have read and write access to the following workspace(s):" lists the project.
const workspaceLine = /workspace\(s\):\s*\n\s*-\s*(.+)/;
const workspaceOf = (content: string): string | undefined => {
  const raw = workspaceLine.exec(content)?.[1]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!raw.toLowerCase().startsWith("file://")) return raw;
  try {
    return fileURLToPath(raw);
  } catch {
    return undefined;
  }
};

const userText = (content: string): string => content.replace(/<\/?USER_REQUEST>/g, "").trim();

const stepMessages = (
  step: TranscriptStep,
  createdAt: string,
): {
  readonly messages: Array<NormalizedMessage>;
  readonly tool: NormalizedToolExecution | null;
} => {
  const key = `s${step.step_index}`;
  const content = step.content ?? "";
  const message = (
    role: NormalizedMessage["role"],
    parts: ReadonlyArray<MessagePart>,
    suffix = "",
  ): NormalizedMessage => ({
    messageKey: `${key}${suffix}`,
    seq: step.step_index,
    role,
    createdAt,
    parts: [...parts],
    text: textOfParts(parts),
  });
  switch (step.type) {
    case "USER_INPUT":
      return {
        messages: [message("user", [{ type: "text", text: userText(content) }])],
        tool: null,
      };
    case "PLANNER_RESPONSE": {
      const parts: Array<MessagePart> = [];
      if (step.thinking !== undefined && step.thinking !== "")
        parts.push({ type: "thinking", text: step.thinking });
      parts.push({ type: "text", text: content });
      return { messages: [message("assistant", parts)], tool: null };
    }
    case "SYSTEM_MESSAGE":
    case "ERROR_MESSAGE":
    case "CHECKPOINT":
      return { messages: [message("system", [{ type: "text", text: content }])], tool: null };
    default: {
      const name = toolTypes[step.type];
      if (name === undefined) return { messages: [], tool: null };
      const isError = step.status !== undefined && /error|fail/i.test(step.status);
      return {
        messages: [
          message("assistant", [{ type: "tool_call", toolKey: key, name, input: {} }]),
          message(
            "tool",
            [
              {
                type: "tool_result",
                toolKey: key,
                output: content,
                ...(isError ? { isError } : {}),
              },
            ],
            ":result",
          ),
        ],
        tool: {
          toolKey: key,
          messageKey: key,
          name,
          input: {},
          output: content,
          status: isError ? "error" : "ok",
          startedAt: createdAt,
        },
      };
    }
  }
};

export const antigravityNormalizer: Normalizer = {
  id: "antigravity",
  parserVersion: 1,
  conversationKeyOf: (streamId) => {
    const match = conversationOfStream.exec(streamId);
    const id = match?.[1] ?? match?.[2];
    return id === undefined ? Option.none() : Option.some(id);
  },
  normalize: (conversationKey, records) => {
    const steps = new Map<number, TranscriptStep>();
    const usage = new Map<string, UsageEntry>();
    let projectPath: string | undefined;
    const ordered = [...records].sort(
      (a, b) => a.streamId.localeCompare(b.streamId) || Number(a.recordKey) - Number(b.recordKey),
    );
    for (const record of ordered) {
      if (record.streamId.includes("#gen_metadata")) {
        const row = decodeUsageRow(record.payload);
        if (Option.isNone(row)) continue;
        const entry =
          decodeUsage(row.value.idx, bytesOfBase64(row.value.data)) ??
          decodeUsage(row.value.idx, new TextEncoder().encode(row.value.data));
        if (entry !== null) usage.set(entry.requestKey, entry);
      } else {
        const step = decodeStep(record.payload);
        if (Option.isNone(step)) continue;
        if (step.value.type === "GENERIC" && step.value.content !== undefined)
          projectPath ??= workspaceOf(step.value.content);
        const previous = steps.get(step.value.step_index);
        if (
          previous === undefined ||
          (step.value.content?.length ?? 0) >= (previous.content?.length ?? 0)
        )
          steps.set(step.value.step_index, step.value);
      }
    }
    if (steps.size === 0 && usage.size === 0) return null;

    const transcript = [...steps.values()].sort((a, b) => a.step_index - b.step_index);
    const firstTime =
      transcript.map((step) => isoOf(step.created_at)).find((value) => value !== undefined) ??
      [...usage.values()].map((entry) => entry.createdAt).find((value) => value !== undefined) ??
      ordered[0]?.observedAt ??
      new Date(0).toISOString();
    const drafts: Array<NormalizedMessage> = [];
    const toolExecutions: Array<NormalizedToolExecution> = [];
    let lastTime = firstTime;
    for (const step of transcript) {
      lastTime = isoOf(step.created_at) ?? lastTime;
      const built = stepMessages(step, lastTime);
      drafts.push(...built.messages);
      if (built.tool !== null) toolExecutions.push(built.tool);
    }
    const messages = drafts.map((message, seq): NormalizedMessage => ({ ...message, seq }));

    const requests: Array<NormalizedRequest> = [...usage.values()].map((entry) => {
      const answerStep =
        [...entry.steps].reverse().find((index) => steps.get(index)?.type === "PLANNER_RESPONSE") ??
        [...entry.steps].reverse().find((index) => steps.has(index));
      const stepTime =
        answerStep === undefined ? undefined : isoOf(steps.get(answerStep)?.created_at);
      return {
        requestKey: entry.requestKey,
        ...(answerStep === undefined ? {} : { messageKey: `s${answerStep}` }),
        modelRaw: entry.modelRaw,
        requestedAt: entry.createdAt ?? stepTime ?? firstTime,
        usage: {
          ...emptyUsage,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          reasoningTokens: entry.reasoningTokens,
        },
        usageBasis: "reported",
      };
    });
    const times = [
      ...messages.map((message) => message.createdAt),
      ...requests.map((request) => request.requestedAt),
    ].sort();
    const firstUser = transcript.find((step) => step.type === "USER_INPUT");
    const title =
      firstUser?.content === undefined ? undefined : userText(firstUser.content).slice(0, 80);
    return {
      conversationKey,
      ...(title === undefined || title === "" ? {} : { title }),
      ...(projectPath === undefined ? {} : { projectPath }),
      startedAt: times[0] ?? firstTime,
      endedAt: times.at(-1) ?? firstTime,
      messages,
      toolExecutions,
      requests,
    } satisfies NormalizedConversation;
  },
};

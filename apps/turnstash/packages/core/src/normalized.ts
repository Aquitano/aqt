import { Schema } from "effect";

import { ContentHash, IsoTimestamp } from "./records.ts";

export const Role = Schema.Literals(["user", "assistant", "system", "tool"]);
export type Role = typeof Role.Type;

export const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
export const ThinkingPart = Schema.Struct({
  type: Schema.Literal("thinking"),
  text: Schema.String,
  redacted: Schema.optionalKey(Schema.Boolean),
});
export const ToolCallPart = Schema.Struct({
  type: Schema.Literal("tool_call"),
  toolKey: Schema.String,
  name: Schema.String,
  input: Schema.Json,
});
export const ToolResultPart = Schema.Struct({
  type: Schema.Literal("tool_result"),
  toolKey: Schema.String,
  output: Schema.NullOr(Schema.String),
  isError: Schema.optionalKey(Schema.Boolean),
});
export const ImagePart = Schema.Struct({
  type: Schema.Literal("image"),
  mediaType: Schema.optionalKey(Schema.String),
  bytes: Schema.optionalKey(Schema.Natural),
  sha256: Schema.optionalKey(ContentHash),
});
export const OpaquePart = Schema.Struct({
  type: Schema.Literal("opaque"),
  kind: Schema.String,
  data: Schema.Json,
});

export const MessagePart = Schema.Union([
  TextPart,
  ThinkingPart,
  ToolCallPart,
  ToolResultPart,
  ImagePart,
  OpaquePart,
]);
export type MessagePart = typeof MessagePart.Type;

export const Usage = Schema.Struct({
  inputTokens: Schema.Natural,
  cacheReadTokens: Schema.Natural,
  cacheWriteTokens: Schema.Natural,
  cacheWrite1hTokens: Schema.Natural,
  outputTokens: Schema.Natural,
  reasoningTokens: Schema.Natural,
});
export type Usage = typeof Usage.Type;

export const emptyUsage: Usage = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  reasoningTokens: a.reasoningTokens + b.reasoningTokens,
});

export const UsageBasis = Schema.Literals(["reported", "cumulative_delta", "estimated"]);
export type UsageBasis = typeof UsageBasis.Type;

export const RequestSpeed = Schema.Literals(["standard", "fast"]);
export type RequestSpeed = typeof RequestSpeed.Type;

export const ToolStatus = Schema.Literals(["ok", "error", "unknown"]);
export type ToolStatus = typeof ToolStatus.Type;

export const NormalizedMessage = Schema.Struct({
  messageKey: Schema.String,
  seq: Schema.Int,
  role: Role,
  parentMessageKey: Schema.optionalKey(Schema.String),
  createdAt: IsoTimestamp,
  parts: Schema.Array(MessagePart),
  text: Schema.String,
});
export type NormalizedMessage = typeof NormalizedMessage.Type;

export const NormalizedToolExecution = Schema.Struct({
  toolKey: Schema.String,
  messageKey: Schema.optionalKey(Schema.String),
  name: Schema.String,
  input: Schema.Json,
  output: Schema.NullOr(Schema.String),
  status: ToolStatus,
  startedAt: Schema.optionalKey(IsoTimestamp),
  endedAt: Schema.optionalKey(IsoTimestamp),
});
export type NormalizedToolExecution = typeof NormalizedToolExecution.Type;

export const NormalizedRequest = Schema.Struct({
  requestKey: Schema.String,
  messageKey: Schema.optionalKey(Schema.String),
  modelRaw: Schema.String,
  routeHint: Schema.optionalKey(Schema.String),
  requestedAt: IsoTimestamp,
  usage: Usage,
  usageBasis: UsageBasis,
  speed: Schema.optionalKey(RequestSpeed),
  sourceRecordKey: Schema.optionalKey(Schema.String),
});
export type NormalizedRequest = typeof NormalizedRequest.Type;

export const NormalizedConversation = Schema.Struct({
  conversationKey: Schema.String,
  parentConversationKey: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  projectPath: Schema.optionalKey(Schema.String),
  gitBranch: Schema.optionalKey(Schema.String),
  clientVersion: Schema.optionalKey(Schema.String),
  startedAt: IsoTimestamp,
  endedAt: IsoTimestamp,
  messages: Schema.Array(NormalizedMessage),
  toolExecutions: Schema.Array(NormalizedToolExecution),
  requests: Schema.Array(NormalizedRequest),
});
export type NormalizedConversation = typeof NormalizedConversation.Type;

export const textOfParts = (parts: ReadonlyArray<MessagePart>): string =>
  parts
    .flatMap((part) => {
      switch (part.type) {
        case "text":
          return [part.text];
        case "thinking":
          return [part.text];
        case "tool_result":
          return part.output === null ? [] : [part.output];
        case "tool_call":
          return [part.name];
        case "image":
        case "opaque":
          return [];
      }
    })
    .join("\n");

import {
  isJsonObject as isObject,
  isOmittedBlob,
  isoTimestampOf,
  jsonCount,
  parseJsonObject,
  storedBlobOf,
  streamPartsOf,
  textOfParts,
  type MessagePart,
  type NormalizedConversation,
  type NormalizedMessage,
  type NormalizedRequest,
  type NormalizedToolExecution,
  type Normalizer,
  type SourceRecordRow,
  type StreamId,
  type Usage,
} from "@aqt/turnstash-core";
import { Option, type Schema } from "effect";

import { toolExecutionOf, type ToolDraft } from "../tool-draft.ts";

const asArray = (value: Schema.Json | undefined): Schema.JsonArray | null =>
  Array.isArray(value) ? value : null;

const asString = (value: Schema.Json | undefined): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const asIso = (value: Schema.Json | undefined): string | null => isoTimestampOf(value) ?? null;

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only the header line carries the session id, so every other line has to reach the same key
// from the file name alone: the uuid suffix Pi writes, else the path the transcript sits at.
const conversationKeyFromPath = (pathLike: string): string => {
  const segments = pathLike
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "");
  const fileName = segments.at(-1) ?? "";
  const base = fileName.endsWith(".jsonl") ? fileName.slice(0, -".jsonl".length) : fileName;
  const suffix = base.slice(base.lastIndexOf("_") + 1);
  return sessionIdPattern.test(suffix) ? suffix.toLowerCase() : segments.slice(-2).join("/");
};

const relativePathOf = (streamId: string): string => {
  return streamPartsOf(streamId)?.relativePath ?? streamId;
};

const conversationKeyOf = (streamId: StreamId, payload: string): Option.Option<string> => {
  if (payload.trim() === "") return Option.none();
  const key = conversationKeyFromPath(relativePathOf(streamId));
  return key === "" ? Option.none() : Option.some(key);
};

interface Entry {
  readonly streamId: string;
  readonly recordKey: string;
  readonly offset: number;
  readonly observedAt: string;
  readonly type: string;
  readonly id: string | null;
  readonly parentId: string | null;
  readonly timestamp: string | null;
  readonly value: Schema.JsonObject;
}

const readEntry = (row: SourceRecordRow): Entry | null => {
  const value = parseJsonObject(row.payload);
  if (value === undefined) return null;
  const type = asString(value["type"]);
  if (type === null) return null;
  const message = value["message"];
  const offset = Number(row.recordKey);
  return {
    streamId: row.streamId,
    recordKey: row.recordKey,
    offset: Number.isFinite(offset) ? offset : 0,
    observedAt: row.observedAt,
    type,
    id: asString(value["id"]),
    parentId: asString(value["parentId"]),
    timestamp:
      asIso(value["timestamp"]) ?? asIso(isObject(message) ? message["timestamp"] : undefined),
    value,
  };
};

const orderedEntries = (records: ReadonlyArray<SourceRecordRow>): ReadonlyArray<Entry> => {
  const entries: Array<Entry> = [];
  for (const record of records) {
    const entry = readEntry(record);
    if (entry !== null) entries.push(entry);
  }
  entries.sort((a, b) => a.offset - b.offset || a.streamId.localeCompare(b.streamId));
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = entry.id ?? `offset:${entry.offset}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const base64Bytes = (data: string): number => {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
};

const imageBytes = (data: Schema.Json | undefined): number | null => {
  if (isOmittedBlob(data)) return data.bytes;
  const encoded = asString(data);
  return encoded === null ? null : base64Bytes(encoded);
};

const partsOfItem = (value: Schema.Json): ReadonlyArray<MessagePart> => {
  if (!isObject(value)) return [];
  const kind = asString(value["type"]);
  switch (kind) {
    case "text": {
      const text = asString(value["text"]);
      return text === null ? [] : [{ type: "text", text }];
    }
    case "thinking": {
      const text = asString(value["thinking"]);
      return text === null ? [] : [{ type: "thinking", text }];
    }
    case "toolCall": {
      const toolKey = asString(value["id"]);
      const name = asString(value["name"]);
      return toolKey === null || name === null
        ? []
        : [{ type: "tool_call", toolKey, name, input: value["arguments"] ?? null }];
    }
    case "image": {
      const mediaType = asString(value["mimeType"]);
      const bytes = imageBytes(value["data"]);
      return [
        {
          type: "image",
          ...(mediaType === null ? {} : { mediaType }),
          ...(bytes === null ? {} : { bytes }),
          ...storedBlobOf(value["data"]),
        },
      ];
    }
    default:
      return kind === null ? [] : [{ type: "opaque", kind, data: value }];
  }
};

const partsOfContent = (content: Schema.Json | undefined): ReadonlyArray<MessagePart> => {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  const items = asArray(content);
  return items === null ? [] : items.flatMap(partsOfItem);
};

const partsOfCustom = (entry: Entry): ReadonlyArray<MessagePart> => {
  const kind = asString(entry.value["customType"]) ?? entry.type;
  const content = asString(entry.value["content"]);
  const data = entry.value["data"] ?? entry.value["details"];
  const parts: Array<MessagePart> = [];
  if (content !== null) parts.push({ type: "text", text: content });
  if (data !== undefined) parts.push({ type: "opaque", kind, data });
  return parts;
};

// Pi copies Anthropic's cache_creation_input_tokens into cacheWrite, so it already holds the
// one-hour writes that cacheWrite1h repeats.
const usageOf = (usage: Schema.JsonObject): Usage => {
  const oneHourWrites = jsonCount(usage["cacheWrite1h"]);
  return {
    inputTokens: jsonCount(usage["input"]),
    cacheReadTokens: jsonCount(usage["cacheRead"]),
    cacheWriteTokens: Math.max(0, jsonCount(usage["cacheWrite"]) - oneHourWrites),
    cacheWrite1hTokens: oneHourWrites,
    outputTokens: jsonCount(usage["output"]),
    reasoningTokens: jsonCount(usage["reasoning"]),
  };
};

// Aborted and errored turns still carry a usage block, all zeros; that is not a billable request.
const isBillable = (usage: Usage): boolean =>
  usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.cacheWrite1hTokens >
    0 || usage.outputTokens > 0;

const qualifiedModel = (model: string, provider: string | null): string =>
  model.includes("/") || provider === null ? model : `${provider}/${model}`;

interface MessageDraft {
  readonly messageKey: string;
  readonly role: "user" | "assistant" | "system";
  readonly parentId: string | null;
  readonly createdAt: string;
  readonly parts: ReadonlyArray<MessagePart>;
}

const emptyToolDraft = (name: string): ToolDraft => ({
  name,
  input: null,
  output: null,
  status: "unknown",
  messageKey: undefined,
  startedAt: undefined,
  endedAt: undefined,
});

const normalize = (
  conversationKey: string,
  records: ReadonlyArray<SourceRecordRow>,
): NormalizedConversation | null => {
  const entries = orderedEntries(records);
  if (entries.length === 0) return null;

  const session = entries.find((entry) => entry.type === "session");
  const drafts: Array<MessageDraft> = [];
  const tools = new Map<string, ToolDraft>();
  const requests: Array<NormalizedRequest> = [];
  const requestKeys = new Set<string>();
  let title: string | null = null;
  let sessionModel: string | null = null;

  for (const entry of entries) {
    const messageKey = entry.id ?? `offset:${entry.offset}`;
    const createdAt = entry.timestamp ?? session?.timestamp ?? entry.observedAt;

    if (entry.type === "session_info") {
      title = asString(entry.value["name"]) ?? title;
      continue;
    }
    if (entry.type === "model_change") {
      const modelId = asString(entry.value["modelId"]);
      if (modelId !== null)
        sessionModel = qualifiedModel(modelId, asString(entry.value["provider"]));
      continue;
    }
    if (entry.type === "custom" || entry.type === "custom_message") {
      const parts = partsOfCustom(entry);
      if (parts.length > 0) {
        drafts.push({ messageKey, role: "system", parentId: entry.parentId, createdAt, parts });
      }
      continue;
    }
    if (entry.type !== "message") continue;

    const message = entry.value["message"];
    if (!isObject(message)) continue;
    const role = asString(message["role"]);

    if (role === "toolResult") {
      const toolKey = asString(message["toolCallId"]);
      if (toolKey === null) continue;
      const name = asString(message["toolName"]);
      const draft = tools.get(toolKey) ?? emptyToolDraft(name ?? "unknown");
      if (name !== null) draft.name = name;
      draft.output = textOfParts(partsOfContent(message["content"]));
      draft.status = message["isError"] === true ? "error" : "ok";
      draft.endedAt = createdAt;
      tools.set(toolKey, draft);
      continue;
    }
    if (role !== "user" && role !== "assistant" && role !== "system") continue;

    const parts = partsOfContent(message["content"]);
    drafts.push({ messageKey, role, parentId: entry.parentId, createdAt, parts });

    for (const part of parts) {
      if (part.type !== "tool_call") continue;
      const draft = tools.get(part.toolKey) ?? emptyToolDraft(part.name);
      draft.name = part.name;
      draft.input = part.input;
      draft.messageKey = messageKey;
      draft.startedAt = createdAt;
      tools.set(part.toolKey, draft);
    }

    const usageValue = message["usage"];
    if (role !== "assistant" || !isObject(usageValue)) continue;
    const usage = usageOf(usageValue);
    if (!isBillable(usage)) continue;
    const provider = asString(message["provider"]);
    const model = asString(message["model"]);
    const candidate = asString(message["responseId"]) ?? messageKey;
    const requestKey = requestKeys.has(candidate) ? `${candidate}:${entry.offset}` : candidate;
    requestKeys.add(requestKey);
    requests.push({
      requestKey,
      messageKey,
      modelRaw: model === null ? (sessionModel ?? "unknown") : qualifiedModel(model, provider),
      ...(provider === null ? {} : { routeHint: provider }),
      requestedAt: createdAt,
      usage,
      usageBasis: "reported",
      sourceRecordKey: entry.recordKey,
    });
  }

  const draftKeys = new Set(drafts.map((draft) => draft.messageKey));
  const messages: ReadonlyArray<NormalizedMessage> = drafts.map((draft, seq) => ({
    messageKey: draft.messageKey,
    seq,
    role: draft.role,
    ...(draft.parentId !== null && draftKeys.has(draft.parentId)
      ? { parentMessageKey: draft.parentId }
      : {}),
    createdAt: draft.createdAt,
    parts: draft.parts,
    text: textOfParts(draft.parts),
  }));

  const toolExecutions: ReadonlyArray<NormalizedToolExecution> = [...tools].map(
    ([toolKey, draft]) => toolExecutionOf(toolKey, draft),
  );

  if (messages.length === 0 && toolExecutions.length === 0) return null;

  const stamps = entries
    .flatMap((entry) => (entry.timestamp === null ? [] : [entry.timestamp]))
    .sort();
  const fallback = asIso(entries[0]?.observedAt) ?? new Date(0).toISOString();
  const startedAt = session?.timestamp ?? stamps[0] ?? fallback;
  const endedAt = stamps.at(-1) ?? startedAt;
  const parentSession = asString(session?.value["parentSession"]);
  const projectPath = asString(session?.value["cwd"]);

  return {
    conversationKey,
    ...(parentSession === null
      ? {}
      : { parentConversationKey: conversationKeyFromPath(parentSession) }),
    ...(title === null ? {} : { title }),
    ...(projectPath === null ? {} : { projectPath }),
    startedAt,
    endedAt,
    messages,
    toolExecutions,
    requests,
  };
};

export const piNormalizer: Normalizer = {
  id: "pi",
  parserVersion: 3,
  conversationKeyOf,
  normalize,
};

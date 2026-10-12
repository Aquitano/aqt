import {
  isJsonObject,
  isoTimestampOf,
  jsonArrayAt as arrayAt,
  jsonCount,
  jsonNumberAt as numberAt,
  jsonObjectAt as objectAt,
  jsonStringAt as stringAt,
  parseJson,
  type MessagePart,
  type NormalizedConversation,
  type NormalizedMessage,
  type NormalizedRequest,
  type NormalizedToolExecution,
  type Normalizer,
  type SourceRecordRow,
  type ToolStatus,
  type Usage,
} from "@aqt/turnstash-core";
import { Option, type Schema } from "effect";

const bubblePrefix = "bubbleId:";
const composerPrefix = "composerData:";

// Cursor stores tool-call sub-composers under a key whose composer segment holds a literal
// newline (`bubbleId:task-call_x\nfc_y:<uuid>`); those rows are not conversations.
const isComposerId = (value: string): boolean => value !== "" && !/[\r\n\0]/.test(value);

const composerIdOfKey = (key: string): string | undefined => {
  if (key.startsWith(bubblePrefix)) {
    const rest = key.slice(bubblePrefix.length);
    const end = rest.indexOf(":");
    const id = end < 0 ? "" : rest.slice(0, end);
    return isComposerId(id) ? id : undefined;
  }
  if (key.startsWith(composerPrefix)) {
    const id = key.slice(composerPrefix.length);
    return isComposerId(id) ? id : undefined;
  }
  return undefined;
};

const bubbleIdOfKey = (key: string): string | undefined => {
  const rest = key.slice(bubblePrefix.length);
  const end = rest.indexOf(":");
  const id = end < 0 ? "" : rest.slice(end + 1);
  return id === "" ? undefined : id;
};

const conversationKeyOf = (_streamId: string, payload: string): Option.Option<string> => {
  const row = parseJson(payload);
  if (!isJsonObject(row)) return Option.none();
  const key = stringAt(row, "key");
  if (key !== undefined) {
    const composerId = composerIdOfKey(key);
    return composerId === undefined ? Option.none() : Option.some(composerId);
  }
  const composerId = stringAt(row, "composerId");
  return composerId !== undefined && isComposerId(composerId)
    ? Option.some(composerId)
    : Option.none();
};

const valueOf = (row: Schema.JsonObject): Schema.Json | undefined => {
  const value = row["value"];
  if (typeof value !== "string") return undefined;
  const text = parseJson(value);
  // A BLOB column reaches the normalizer base64 encoded, never as JSON text.
  return text ?? parseJson(Buffer.from(value, "base64").toString("utf8"));
};

const dedupeKeyOf = (row: Schema.JsonObject): string | undefined => {
  const key = stringAt(row, "key");
  if (key !== undefined) return `kv:${key}`;
  const composerId = stringAt(row, "composerId");
  return composerId === undefined ? undefined : `header:${composerId}`;
};

const isNewer = (candidate: SourceRecordRow, current: SourceRecordRow): boolean =>
  candidate.observedAt === current.observedAt
    ? candidate.payload > current.payload
    : candidate.observedAt > current.observedAt;

const latestRows = (records: ReadonlyArray<SourceRecordRow>): ReadonlyArray<Schema.JsonObject> => {
  const byKey = new Map<
    string,
    { readonly record: SourceRecordRow; readonly row: Schema.JsonObject }
  >();
  for (const record of records) {
    const row = parseJson(record.payload);
    if (!isJsonObject(row)) continue;
    const key = dedupeKeyOf(row);
    if (key === undefined) continue;
    const previous = byKey.get(key);
    if (previous === undefined || isNewer(record, previous.record)) byKey.set(key, { record, row });
  }
  return [...byKey.values()].map((entry) => entry.row);
};

interface Bubble {
  readonly recordKey: string;
  readonly bubbleId: string;
  readonly role: "user" | "assistant";
  readonly body: Schema.JsonObject;
  readonly startedAt: number | undefined;
  readonly endedAt: number | undefined;
}

const bubbleOf = (key: string, body: Schema.Json | undefined): Bubble | undefined => {
  if (!isJsonObject(body)) return undefined;
  const bubbleId = bubbleIdOfKey(key);
  const type = numberAt(body, "type");
  if (bubbleId === undefined || (type !== 1 && type !== 2)) return undefined;
  const timing = objectAt(body, "timingInfo");
  return {
    recordKey: key,
    bubbleId,
    role: type === 1 ? "user" : "assistant",
    body,
    startedAt: numberAt(timing, "clientRpcSendTime"),
    endedAt: numberAt(timing, "clientSettleTime"),
  };
};

const flattenRichText = (node: Schema.Json | undefined): string => {
  if (!isJsonObject(node)) return "";
  const own = typeof node["text"] === "string" ? node["text"] : "";
  const separator = node["type"] === "root" ? "\n" : "";
  return own + arrayAt(node, "children").map(flattenRichText).join(separator);
};

const textOf = (body: Schema.JsonObject): string =>
  stringAt(body, "text") ?? flattenRichText(objectAt(body, "richText")?.["root"]);

const sharedToolNames = new Map([
  ["Shell", "Bash"],
  ["run_terminal_cmd", "Bash"],
]);

const toolKeyOf = (bubble: Bubble, tool: Schema.JsonObject): string =>
  stringAt(tool, "toolCallId") ?? `${bubble.bubbleId}:${numberAt(tool, "toolIndex") ?? 0}`;

const toolNameOf = (tool: Schema.JsonObject): string => {
  const name = stringAt(tool, "name");
  if (name !== undefined) return sharedToolNames.get(name) ?? name;
  const numeric = numberAt(tool, "tool");
  return numeric === undefined ? "unknown" : `tool:${numeric}`;
};

const toolInputOf = (tool: Schema.JsonObject): Schema.Json => {
  const raw = stringAt(tool, "rawArgs");
  const parsed = raw === undefined ? undefined : parseJson(raw);
  if (parsed !== undefined) return parsed;
  return objectAt(tool, "params") ?? (raw === undefined ? null : { rawArgs: raw });
};

const toolOutputOf = (tool: Schema.JsonObject): string | null => {
  const result = stringAt(tool, "result");
  if (result !== undefined) return result;
  const error = tool["error"];
  if (error === undefined || error === null) return null;
  return typeof error === "string" ? error : JSON.stringify(error);
};

const toolStatusOf = (tool: Schema.JsonObject): ToolStatus => {
  const error = tool["error"];
  if (error !== undefined && error !== null && error !== "") return "error";
  const status = stringAt(tool, "status");
  if (status === "completed") return "ok";
  return status === "error" ? "error" : "unknown";
};

const partsOf = (bubble: Bubble): ReadonlyArray<MessagePart> => {
  const parts: Array<MessagePart> = [];
  const text = textOf(bubble.body);
  if (text !== "") parts.push({ type: "text", text });
  const thinking = stringAt(objectAt(bubble.body, "thinking"), "text");
  if (thinking !== undefined) parts.push({ type: "thinking", text: thinking });
  const tool = objectAt(bubble.body, "toolFormerData");
  if (tool !== undefined) {
    const toolKey = toolKeyOf(bubble, tool);
    const status = toolStatusOf(tool);
    const output = toolOutputOf(tool);
    parts.push({ type: "tool_call", toolKey, name: toolNameOf(tool), input: toolInputOf(tool) });
    if (output !== null || status !== "unknown") {
      parts.push({ type: "tool_result", toolKey, output, isError: status === "error" });
    }
    const decision = stringAt(tool, "userDecision");
    if (decision !== undefined)
      parts.push({ type: "opaque", kind: "cursor_tool_decision", data: { toolKey, decision } });
  }
  for (const image of arrayAt(bubble.body, "images")) {
    const mediaType = stringAt(image, "mediaType") ?? stringAt(image, "mimeType");
    parts.push(mediaType === undefined ? { type: "image" } : { type: "image", mediaType });
  }
  for (const block of arrayAt(bubble.body, "codeBlocks")) {
    const languageId = stringAt(block, "languageId");
    if (languageId !== undefined)
      parts.push({ type: "opaque", kind: "cursor_code_block", data: { languageId } });
  }
  return parts;
};

// Tool results reach six figures of characters, so they stay on the tool execution
// instead of the message text the server indexes for search.
const searchableText = (parts: ReadonlyArray<MessagePart>): string =>
  parts
    .flatMap((part) => (part.type === "text" || part.type === "thinking" ? [part.text] : []))
    .join("\n");

const charsPerToken = 4;

const estimateTokens = (characters: number): number => Math.ceil(characters / charsPerToken);

const countOf = (body: Schema.JsonObject, key: string): number =>
  jsonCount(objectAt(body, "tokenCount")?.[key]);

const reportedUsage = (bubbles: ReadonlyArray<Bubble>): Usage => ({
  inputTokens: bubbles.reduce((total, bubble) => total + countOf(bubble.body, "inputTokens"), 0),
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  outputTokens: bubbles.reduce((total, bubble) => total + countOf(bubble.body, "outputTokens"), 0),
  reasoningTokens: 0,
});

// v3 bubbles report {0, 0}: the only signal left is the visible text of the turn.
const estimatedUsage = (bubbles: ReadonlyArray<Bubble>): Usage => {
  const charsOf = (role: "user" | "assistant"): number =>
    bubbles.reduce(
      (total, bubble) => (bubble.role === role ? total + textOf(bubble.body).length : total),
      0,
    );
  return {
    inputTokens: estimateTokens(charsOf("user")),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: estimateTokens(charsOf("assistant")),
    reasoningTokens: 0,
  };
};

const requestKeyOf = (bubble: Bubble): string => {
  const usageUuid = stringAt(bubble.body, "usageUuid");
  if (usageUuid !== undefined) return `usage:${usageUuid}`;
  const requestId = stringAt(bubble.body, "requestId");
  return requestId === undefined ? `bubble:${bubble.bubbleId}` : `request:${requestId}`;
};

const autoModel = "cursor-auto";

const modelOf = (composer: Schema.JsonObject | undefined): string => {
  const configured = stringAt(objectAt(composer, "modelConfig"), "modelName");
  if (configured !== undefined && configured !== "default") return configured;
  const usageData = objectAt(composer, "usageData");
  return usageData === undefined ? autoModel : (Object.keys(usageData).sort()[0] ?? autoModel);
};

const orderOf = (composer: Schema.JsonObject | undefined): ReadonlyMap<string, number> => {
  const order = new Map<string, number>();
  arrayAt(composer, "fullConversationHeadersOnly").forEach((entry, index) => {
    const bubbleId = stringAt(entry, "bubbleId");
    if (bubbleId !== undefined && !order.has(bubbleId)) order.set(bubbleId, index);
  });
  return order;
};

const compareBubbles =
  (order: ReadonlyMap<string, number>) =>
  (a: Bubble, b: Bubble): number => {
    const rank =
      (order.get(a.bubbleId) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.bubbleId) ?? Number.MAX_SAFE_INTEGER);
    if (rank !== 0) return rank;
    const time = (a.startedAt ?? 0) - (b.startedAt ?? 0);
    if (time !== 0) return time;
    return a.recordKey < b.recordKey ? -1 : a.recordKey > b.recordKey ? 1 : 0;
  };

const iso = (milliseconds: number | undefined): string =>
  isoTimestampOf(milliseconds) ?? new Date(0).toISOString();

const projectPathOf = (header: Schema.JsonObject | undefined): string | undefined => {
  const uri = objectAt(objectAt(valueOf(header ?? {}), "workspaceIdentifier"), "uri");
  return stringAt(uri, "path") ?? stringAt(uri, "fsPath");
};

const titleLimit = 120;

const titleOf = (
  composer: Schema.JsonObject | undefined,
  messages: ReadonlyArray<NormalizedMessage>,
): string | undefined => {
  const name = stringAt(composer, "name");
  if (name !== undefined) return name;
  const prompt = messages.find((message) => message.role === "user")?.text.trim();
  return prompt === undefined || prompt === "" ? undefined : prompt.slice(0, titleLimit);
};

const normalize = (
  conversationKey: string,
  records: ReadonlyArray<SourceRecordRow>,
): NormalizedConversation | null => {
  let composer: Schema.JsonObject | undefined;
  let header: Schema.JsonObject | undefined;
  const bubbles: Array<Bubble> = [];
  for (const row of latestRows(records)) {
    const key = stringAt(row, "key");
    if (key === undefined) {
      if (stringAt(row, "composerId") !== undefined) header = row;
      continue;
    }
    if (key.startsWith(composerPrefix)) {
      const value = valueOf(row);
      if (isJsonObject(value)) composer = value;
      continue;
    }
    const bubble = bubbleOf(key, valueOf(row));
    if (bubble !== undefined) bubbles.push(bubble);
  }
  if (bubbles.length === 0) return null;

  bubbles.sort(compareBubbles(orderOf(composer)));

  const lastActivity = bubbles.reduce<number | undefined>((latest, bubble) => {
    const time = bubble.endedAt ?? bubble.startedAt;
    return time === undefined ? latest : Math.max(latest ?? time, time);
  }, undefined);
  const startedAt =
    numberAt(header, "createdAt") ??
    numberAt(composer, "createdAt") ??
    bubbles[0]?.startedAt ??
    Math.min(...records.map((record) => Date.parse(record.observedAt)));
  const endedAt =
    numberAt(header, "lastUpdatedAt") ??
    numberAt(header, "recency") ??
    numberAt(composer, "lastUpdatedAt") ??
    lastActivity;

  const messages: Array<NormalizedMessage> = [];
  const toolExecutions: Array<NormalizedToolExecution> = [];
  const seenToolKeys = new Set<string>();
  for (const bubble of bubbles) {
    const parts = partsOf(bubble);
    messages.push({
      messageKey: bubble.bubbleId,
      seq: messages.length,
      role: bubble.role,
      createdAt: iso(bubble.startedAt ?? startedAt),
      parts,
      text: searchableText(parts),
    });
    const tool = objectAt(bubble.body, "toolFormerData");
    if (tool === undefined) continue;
    const toolKey = toolKeyOf(bubble, tool);
    if (seenToolKeys.has(toolKey)) continue;
    seenToolKeys.add(toolKey);
    toolExecutions.push({
      toolKey,
      messageKey: bubble.bubbleId,
      name: toolNameOf(tool),
      input: toolInputOf(tool),
      output: toolOutputOf(tool),
      status: toolStatusOf(tool),
      ...(bubble.startedAt === undefined ? {} : { startedAt: iso(bubble.startedAt) }),
      ...(bubble.endedAt === undefined ? {} : { endedAt: iso(bubble.endedAt) }),
    });
  }

  const groups = new Map<string, Array<Bubble>>();
  for (const bubble of bubbles) {
    const key = requestKeyOf(bubble);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [bubble]);
    } else {
      group.push(bubble);
    }
  }

  const modelRaw = modelOf(composer);
  const requests: Array<NormalizedRequest> = [];
  for (const [requestKey, group] of groups) {
    const reported = reportedUsage(group);
    const usage =
      reported.inputTokens + reported.outputTokens > 0 ? reported : estimatedUsage(group);
    if (usage.inputTokens + usage.outputTokens === 0) continue;
    const anchor = group.find((bubble) => bubble.role === "assistant") ?? group[0];
    if (anchor === undefined) continue;
    requests.push({
      requestKey,
      messageKey: anchor.bubbleId,
      modelRaw,
      requestedAt: iso(
        group.find((bubble) => bubble.startedAt !== undefined)?.startedAt ?? startedAt,
      ),
      usage,
      usageBasis: usage === reported ? "reported" : "estimated",
      sourceRecordKey: anchor.recordKey,
    });
  }

  const title = titleOf(composer, messages);
  const projectPath = projectPathOf(header);
  return {
    conversationKey,
    ...(title === undefined ? {} : { title }),
    ...(projectPath === undefined ? {} : { projectPath }),
    startedAt: iso(startedAt),
    endedAt: iso(Math.max(startedAt, endedAt ?? startedAt)),
    messages,
    toolExecutions,
    requests,
  };
};

export const cursorNormalizer: Normalizer = {
  id: "cursor",
  parserVersion: 3,
  conversationKeyOf,
  normalize,
};

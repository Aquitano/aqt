import {
  isJsonObject,
  isoTimestampOf as isoOf,
  jsonArrayAt as arrayAt,
  jsonNumberAt as numberAt,
  jsonObjectAt as objectAt,
  jsonStringAt as stringAt,
  parseJsonObject,
  sqliteTableOf,
  storedBlobOf,
  streamPartsOf,
  emptyUsage,
  textOfParts,
  type MessagePart,
  type NormalizedConversation,
  type NormalizedMessage,
  type NormalizedRequest,
  type NormalizedToolExecution,
  type Normalizer,
  type Role,
  type SourceRecordRow,
  type StreamId,
  type ToolStatus,
  type Usage,
  withJsonField,
} from "@aqt/turnstash-core";
import { Option, Predicate, type Schema } from "effect";

type Json = Schema.Json;

const naturalOf = (value: Json | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

// OpenCode stamps are epoch ms, except very old rows that still hold epoch seconds.
const epochMillis = (value: Json | undefined): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const millis = Math.round(value < 1e12 ? value * 1000 : value);
  return millis > 8.64e15 ? undefined : millis;
};

type SourceKind =
  | "session_v2"
  | "session_message"
  | "session"
  | "message"
  | "part"
  | "file_session"
  | "file_message"
  | "file_part";

const sqliteTables = new Set(["session_v2", "session_message", "session", "message", "part"]);
const sessionKinds = new Set<SourceKind>(["session_v2", "session", "file_session"]);

const isSqliteKind = (value: string): value is SourceKind => sqliteTables.has(value);

const kindOfStream = (streamId: StreamId): SourceKind | undefined => {
  const stream = streamPartsOf(streamId);
  if (stream?.kind === "sqlite") {
    const table = sqliteTableOf(stream);
    return table !== undefined && isSqliteKind(table) ? table : undefined;
  }
  if (stream?.kind !== "json") return undefined;
  const { relativePath } = stream;
  if (relativePath.startsWith("storage/session/")) return "file_session";
  if (relativePath.startsWith("storage/message/")) return "file_message";
  if (relativePath.startsWith("storage/part/")) return "file_part";
  return undefined;
};

const conversationKeyOf = (streamId: StreamId, payload: string): Option.Option<string> => {
  const kind = kindOfStream(streamId);
  if (kind === undefined) return Option.none();
  const row = parseJsonObject(payload);
  if (row === undefined) return Option.none();
  const key = sessionKinds.has(kind)
    ? stringAt(row, "id")
    : stringAt(row, "session_id", "sessionID");
  return key === undefined ? Option.none() : Option.some(key);
};

interface Entry {
  readonly kind: SourceKind;
  readonly id: string;
  readonly messageId: string | undefined;
  readonly row: Schema.JsonObject;
  readonly data: Schema.JsonObject;
  readonly seq: number;
  readonly createdAt: number | undefined;
  readonly updatedAt: number;
  readonly recordKey: string;
  readonly observedAt: string;
  readonly payload: string;
}

// A `data` column is TEXT holding JSON on most builds and a BLOB on some, which arrives base64.
const dataOf = (kind: SourceKind, row: Schema.JsonObject): Schema.JsonObject | undefined => {
  if (sessionKinds.has(kind) || kind === "file_message" || kind === "file_part") return row;
  const value = row["data"];
  if (isJsonObject(value)) return value;
  if (typeof value !== "string") return undefined;
  return parseJsonObject(value) ?? parseJsonObject(Buffer.from(value, "base64").toString("utf8"));
};

const entryOf = (record: SourceRecordRow): Entry | undefined => {
  const kind = kindOfStream(record.streamId);
  if (kind === undefined) return undefined;
  const row = parseJsonObject(record.payload);
  if (row === undefined) return undefined;
  const id = stringAt(row, "id");
  if (id === undefined) return undefined;
  const data = dataOf(kind, row);
  if (data === undefined) return undefined;
  const rowTime = objectAt(row, "time");
  const dataTime = objectAt(data, "time");
  const createdAt =
    epochMillis(row["time_created"]) ??
    epochMillis(rowTime?.["created"]) ??
    epochMillis(dataTime?.["created"]);
  return {
    kind,
    id,
    messageId: stringAt(row, "message_id", "messageID"),
    row,
    data,
    seq: numberAt(row, "seq") ?? 0,
    createdAt,
    updatedAt:
      epochMillis(row["time_updated"]) ?? epochMillis(rowTime?.["updated"]) ?? createdAt ?? 0,
    recordKey: record.recordKey,
    observedAt: record.observedAt,
    payload: record.payload,
  };
};

// Rows mutate while a turn streams, and two machines can hold different versions of the same row.
const latestOf = (a: Entry, b: Entry): Entry => {
  // The file store survives migration, but SQLite is the store the CLI continues to update.
  if (a.kind === "part" && b.kind === "file_part") return a;
  if (a.kind === "file_part" && b.kind === "part") return b;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  if (a.observedAt !== b.observedAt) return a.observedAt > b.observedAt ? a : b;
  // Ties compare the trimmed form, so a stored record picks the same version before and after trimming.
  return trimmedPayload(a.kind, a.payload) >= trimmedPayload(b.kind, b.payload) ? a : b;
};

const builtinTools = new Set(
  "shell read edit grep write websearch webfetch bash glob todowrite apply_patch skill subagent question task".split(
    " ",
  ),
);

const canonicalToolName = (name: string): string => {
  const separator = name.indexOf("_");
  if (separator <= 0 || name.startsWith("mcp__") || builtinTools.has(name)) return name;
  return `mcp__${name.slice(0, separator)}__${name.slice(separator + 1)}`;
};

const toolStatusOf = (status: string | undefined): ToolStatus => {
  if (status === "completed" || status === "success") return "ok";
  if (status === "error" || status === "failed") return "error";
  return "unknown";
};

const toolOutputOf = (state: Schema.JsonObject): string | null => {
  const output = state["output"];
  if (typeof output === "string") return output;
  const texts: Array<string> = [];
  for (const item of arrayAt(state, "content")) {
    if (!isJsonObject(item)) continue;
    const text = stringAt(item, "text");
    if (text !== undefined) texts.push(text);
  }
  if (texts.length > 0) return texts.join("\n");
  const error = state["error"];
  if (error === undefined || error === null) return null;
  return typeof error === "string" ? error : JSON.stringify(error);
};

interface Built {
  readonly parts: Array<MessagePart>;
  readonly tools: Array<NormalizedToolExecution>;
}

const appendTool = (
  built: Built,
  messageKey: string,
  item: Schema.JsonObject,
  fallbackKey: string,
): void => {
  const toolKey = stringAt(item, "id", "callID", "callId") ?? fallbackKey;
  const name = canonicalToolName(stringAt(item, "name", "tool") ?? "unknown");
  const state = objectAt(item, "state") ?? {};
  const time = objectAt(state, "time") ?? objectAt(item, "time");
  const input = state["input"] ?? null;
  const output = toolOutputOf(state);
  const status = toolStatusOf(stringAt(state, "status"));
  const startedAt = isoOf(epochMillis(time?.["created"]) ?? epochMillis(time?.["start"]));
  const endedAt = isoOf(epochMillis(time?.["completed"]) ?? epochMillis(time?.["end"]));
  built.parts.push({ type: "tool_call", toolKey, name, input });
  if (output !== null || status === "error") {
    built.parts.push({
      type: "tool_result",
      toolKey,
      output,
      ...(status === "error" ? { isError: true } : {}),
    });
  }
  built.tools.push({
    toolKey,
    messageKey,
    name,
    input,
    output,
    status,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
  });
};

interface ModelRef {
  readonly modelRaw: string;
  readonly routeHint: string | undefined;
}

const modelOf = (source: Schema.JsonObject): ModelRef | undefined => {
  const nested = objectAt(source, "model");
  const providerId =
    stringAt(nested ?? source, "providerID", "provider_id") ?? stringAt(source, "providerID");
  const modelId =
    nested === undefined ? stringAt(source, "modelID", "model_id") : stringAt(nested, "id");
  if (modelId === undefined) return undefined;
  return {
    modelRaw: providerId === undefined ? modelId : `${providerId}/${modelId}`,
    routeHint: providerId,
  };
};

// The session row keeps its model as a JSON string in a TEXT column.
const sessionModelOf = (session: Entry | undefined): ModelRef | undefined => {
  if (session === undefined) return undefined;
  const value = session.row["model"];
  const model = isJsonObject(value)
    ? value
    : typeof value === "string"
      ? parseJsonObject(value)
      : undefined;
  return model === undefined ? undefined : modelOf({ model });
};

const usageOf = (data: Schema.JsonObject): Usage | undefined => {
  const tokens = objectAt(data, "tokens");
  if (tokens !== undefined) {
    const cache = objectAt(tokens, "cache");
    const reasoningTokens = naturalOf(tokens["reasoning"]);
    return {
      inputTokens: naturalOf(tokens["input"]),
      cacheReadTokens: naturalOf(cache?.["read"]),
      cacheWriteTokens: naturalOf(cache?.["write"]),
      cacheWrite1hTokens: 0,
      outputTokens: naturalOf(tokens["output"]) + reasoningTokens,
      reasoningTokens,
    };
  }
  const usage = objectAt(data, "usage");
  if (usage === undefined) return undefined;
  return {
    inputTokens: naturalOf(usage["input_tokens"]),
    cacheReadTokens: naturalOf(usage["cache_read_input_tokens"]),
    cacheWriteTokens: naturalOf(usage["cache_creation_input_tokens"]),
    cacheWrite1hTokens: 0,
    outputTokens: naturalOf(usage["output_tokens"]),
    reasoningTokens: 0,
  };
};

const totalOf = (usage: Usage): number =>
  usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;

interface RequestInput {
  readonly requestKey: string;
  readonly messageKey: string;
  readonly recordKey: string;
  readonly data: Schema.JsonObject;
  readonly requestedAt: number | undefined;
  readonly observedAt: string;
  readonly sessionModel: ModelRef | undefined;
  readonly hasContent: boolean;
}

const requestOf = (input: RequestInput): NormalizedRequest | undefined => {
  const usage = usageOf(input.data);
  const cost = numberAt(input.data, "cost") ?? 0;
  if (usage === undefined && cost <= 0) return undefined;
  const reported = usage === undefined ? 0 : totalOf(usage);
  if (reported === 0 && cost <= 0 && !input.hasContent) return undefined;
  const model = modelOf(input.data) ?? input.sessionModel;
  return {
    requestKey: input.requestKey,
    messageKey: input.messageKey,
    modelRaw: model?.modelRaw ?? "unknown",
    ...(model?.routeHint === undefined ? {} : { routeHint: model.routeHint }),
    requestedAt: isoOf(input.requestedAt) ?? input.observedAt,
    usage: usage ?? emptyUsage,
    usageBasis: "reported",
    sourceRecordKey: input.recordKey,
  };
};

const rollupRequestOf = (session: Entry): NormalizedRequest | undefined => {
  const reasoningTokens = naturalOf(session.row["tokens_reasoning"]);
  const usage: Usage = {
    inputTokens: naturalOf(session.row["tokens_input"]),
    cacheReadTokens: naturalOf(session.row["tokens_cache_read"]),
    cacheWriteTokens: naturalOf(session.row["tokens_cache_write"]),
    cacheWrite1hTokens: 0,
    outputTokens: naturalOf(session.row["tokens_output"]) + reasoningTokens,
    reasoningTokens,
  };
  const cost = numberAt(session.row, "cost") ?? 0;
  if (totalOf(usage) === 0 && cost <= 0) return undefined;
  const model = sessionModelOf(session);
  return {
    requestKey: "session-level",
    modelRaw: model?.modelRaw ?? "unknown",
    ...(model?.routeHint === undefined ? {} : { routeHint: model.routeHint }),
    requestedAt: isoOf(session.createdAt) ?? session.observedAt,
    usage,
    usageBasis: "estimated",
    sourceRecordKey: session.recordKey,
  };
};

const v2Roles: Record<string, Role> = {
  user: "user",
  assistant: "assistant",
  compaction: "assistant",
  synthetic: "system",
  system: "system",
  skill: "system",
};

const legacyRoles: Record<string, Role> = {
  user: "user",
  assistant: "assistant",
  system: "system",
  tool: "tool",
};

interface MessageBuild {
  readonly message: NormalizedMessage;
  readonly tools: ReadonlyArray<NormalizedToolExecution>;
  readonly requests: ReadonlyArray<NormalizedRequest>;
}

const messageOf = (
  entry: Entry,
  seq: number,
  role: Role,
  built: Built,
  parentMessageKey: string | undefined,
): NormalizedMessage => ({
  messageKey: entry.id,
  seq,
  role,
  ...(parentMessageKey === undefined ? {} : { parentMessageKey }),
  createdAt: isoOf(entry.createdAt) ?? entry.observedAt,
  parts: built.parts,
  text: textOfParts(built.parts),
});

const buildV2Message = (
  entry: Entry,
  seq: number,
  sessionModel: ModelRef | undefined,
): MessageBuild => {
  const type = stringAt(entry.row, "type") ?? "assistant";
  const built: Built = { parts: [], tools: [] };
  const text = stringAt(entry.data, "text");
  if (text !== undefined) built.parts.push({ type: "text", text });
  const files = arrayAt(entry.data, "files");
  const otherFiles: Array<Json> = [];
  for (const file of files) {
    const mediaType = isJsonObject(file) ? stringAt(file, "mime") : undefined;
    if (isJsonObject(file) && mediaType?.startsWith("image/") === true)
      built.parts.push({ type: "image", mediaType, ...storedBlobOf(file["data"]) });
    else otherFiles.push(file);
  }
  if (otherFiles.length > 0) built.parts.push({ type: "opaque", kind: "files", data: otherFiles });
  if (type !== "user" && type !== "assistant") {
    built.parts.push({ type: "opaque", kind: type, data: entry.data });
  }
  for (const [index, item] of arrayAt(entry.data, "content").entries()) {
    if (!isJsonObject(item)) continue;
    const itemType = stringAt(item, "type");
    const itemText = stringAt(item, "text");
    if (itemType === "text" && itemText !== undefined)
      built.parts.push({ type: "text", text: itemText });
    else if (itemType === "reasoning" && itemText !== undefined) {
      built.parts.push({ type: "thinking", text: itemText });
    } else if (itemType === "tool") appendTool(built, entry.id, item, `${entry.id}:${index}`);
    else built.parts.push({ type: "opaque", kind: itemType ?? "content", data: item });
  }
  const request =
    type === "assistant" || type === "compaction"
      ? requestOf({
          requestKey: entry.id,
          messageKey: entry.id,
          recordKey: entry.recordKey,
          observedAt: entry.observedAt,
          data: entry.data,
          requestedAt: epochMillis(objectAt(entry.data, "time")?.["created"]) ?? entry.createdAt,
          sessionModel,
          hasContent: built.parts.length > 0,
        })
      : undefined;
  return {
    message: messageOf(entry, seq, v2Roles[type] ?? "system", built, undefined),
    tools: built.tools,
    requests: request === undefined ? [] : [request],
  };
};

const buildLegacyMessage = (
  entry: Entry,
  parts: ReadonlyArray<Entry>,
  seq: number,
  sessionModel: ModelRef | undefined,
): MessageBuild => {
  const built: Built = { parts: [], tools: [] };
  const steps: Array<Entry> = [];
  for (const part of parts) {
    const type = stringAt(part.data, "type");
    const text = stringAt(part.data, "text");
    if (type === "text" && text !== undefined) built.parts.push({ type: "text", text });
    else if (type === "reasoning" && text !== undefined)
      built.parts.push({ type: "thinking", text });
    else if (type === "tool") appendTool(built, entry.id, part.data, part.id);
    else if (type === "step-finish") steps.push(part);
    else if (type === "step-start") continue;
    else if (type === "file") {
      const mediaType = stringAt(part.data, "mime");
      const filename = stringAt(part.data, "filename");
      if (mediaType?.startsWith("image/") === true)
        built.parts.push({ type: "image", mediaType, ...storedBlobOf(part.data["url"]) });
      else {
        built.parts.push({
          type: "opaque",
          kind: "file",
          data: {
            ...(filename === undefined ? {} : { filename }),
            ...(mediaType === undefined ? {} : { mediaType }),
          },
        });
      }
    } else built.parts.push({ type: "opaque", kind: type ?? "part", data: part.data });
  }
  const role = legacyRoles[stringAt(entry.data, "role") ?? ""] ?? "system";
  const completedAt = epochMillis(objectAt(entry.data, "time")?.["completed"]);
  const requestedAt = epochMillis(objectAt(entry.data, "time")?.["created"]) ?? entry.createdAt;
  const priced =
    role !== "assistant"
      ? []
      : steps.flatMap((step) => {
          const request = requestOf({
            requestKey: step.id,
            messageKey: entry.id,
            recordKey: step.recordKey,
            observedAt: entry.observedAt,
            data: step.data,
            requestedAt: completedAt ?? requestedAt,
            sessionModel: modelOf(entry.data) ?? sessionModel,
            hasContent: false,
          });
          return request === undefined ? [] : [request];
        });
  const fallback =
    role !== "assistant" || priced.length > 0
      ? undefined
      : requestOf({
          requestKey: entry.id,
          messageKey: entry.id,
          recordKey: entry.recordKey,
          observedAt: entry.observedAt,
          data: entry.data,
          requestedAt,
          sessionModel,
          hasContent: built.parts.length > 0,
        });
  return {
    message: messageOf(entry, seq, role, built, stringAt(entry.data, "parentID", "parent_id")),
    tools: built.tools,
    requests: fallback === undefined ? priced : [fallback],
  };
};

const compareEntries = (a: Entry, b: Entry): number =>
  a.seq - b.seq ||
  (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const normalize = (
  conversationKey: string,
  records: ReadonlyArray<SourceRecordRow>,
): NormalizedConversation | null => {
  const deduped = new Map<string, Entry>();
  for (const record of records) {
    const entry = entryOf(record);
    if (entry === undefined) continue;
    const key = `${entry.kind === "file_part" ? "part" : entry.kind}:${entry.id}`;
    const previous = deduped.get(key);
    deduped.set(key, previous === undefined ? entry : latestOf(previous, entry));
  }
  const entries = [...deduped.values()];
  const ofKind = (kind: SourceKind): Array<Entry> => entries.filter((entry) => entry.kind === kind);

  const v2Rows = ofKind("session_message");
  const legacyRows = ofKind("message");
  const fileRows = ofKind("file_message");
  const generation = v2Rows.length > 0 ? "v2" : legacyRows.length > 0 ? "legacy" : "file";
  const headers = {
    v2: ofKind("session_v2"),
    legacy: ofKind("session"),
    file: ofKind("file_session"),
  };
  const session = headers[generation][0] ?? headers.v2[0] ?? headers.legacy[0] ?? headers.file[0];
  const sessionModel = sessionModelOf(session);

  const messages: Array<NormalizedMessage> = [];
  const toolExecutions: Array<NormalizedToolExecution> = [];
  const requests: Array<NormalizedRequest> = [];
  const collect = (build: MessageBuild): void => {
    messages.push(build.message);
    toolExecutions.push(...build.tools);
    requests.push(...build.requests);
  };

  if (generation === "v2") {
    v2Rows
      .sort(compareEntries)
      .forEach((entry, index) => collect(buildV2Message(entry, index, sessionModel)));
  } else {
    const partsByMessage = new Map<string, Array<Entry>>();
    for (const part of [...ofKind("part"), ...ofKind("file_part")]) {
      if (part.messageId === undefined) continue;
      const existing = partsByMessage.get(part.messageId);
      if (existing === undefined) partsByMessage.set(part.messageId, [part]);
      else existing.push(part);
    }
    const rows = generation === "legacy" ? legacyRows : fileRows;
    rows.sort(compareEntries).forEach((entry, index) => {
      const parts = (partsByMessage.get(entry.id) ?? []).sort(compareEntries);
      collect(buildLegacyMessage(entry, parts, index, sessionModel));
    });
  }

  if (requests.length === 0 && session !== undefined) {
    const rollup = rollupRequestOf(session);
    if (rollup !== undefined) requests.push(rollup);
  }
  if (messages.length === 0 && requests.length === 0) return null;

  const stamps = [
    ...(session?.createdAt === undefined ? [] : [session.createdAt]),
    ...(session === undefined || session.updatedAt === 0 ? [] : [session.updatedAt]),
    ...messages.map((message) => Date.parse(message.createdAt)),
    ...toolExecutions.flatMap((tool) =>
      tool.endedAt === undefined ? [] : [Date.parse(tool.endedAt)],
    ),
    ...requests.map((request) => Date.parse(request.requestedAt)),
  ].filter((stamp) => Number.isFinite(stamp));
  const startedAt = new Date(Math.min(...stamps)).toISOString();
  const endedAt = new Date(Math.max(...stamps)).toISOString();

  const projectPath =
    (session === undefined ? undefined : stringAt(session.row, "directory", "path")) ??
    entries.reduce<string | undefined>(
      (found, entry) => found ?? stringAt(objectAt(entry.data, "path") ?? {}, "cwd", "root"),
      undefined,
    );
  const title = session === undefined ? undefined : stringAt(session.row, "title");
  const clientVersion = session === undefined ? undefined : stringAt(session.row, "version");
  const parentConversationKey =
    session === undefined ? undefined : stringAt(session.row, "parent_id", "parentID");

  return {
    conversationKey,
    ...(parentConversationKey === undefined ? {} : { parentConversationKey }),
    ...(title === undefined ? {} : { title }),
    ...(projectPath === undefined ? {} : { projectPath }),
    ...(clientVersion === undefined ? {} : { clientVersion }),
    startedAt,
    endedAt,
    messages,
    toolExecutions,
    requests,
  };
};

// Rows whose data normalize parses are kept with that data as an object rather than escaped JSON text.
const trimmedPayload = (kind: SourceKind, payload: string): string => {
  if (!isSqliteKind(kind) || sessionKinds.has(kind)) return payload;
  const row = parseJsonObject(payload);
  const data = row?.["data"];
  if (row === undefined || !Predicate.isString(data)) return payload;
  const parsed = dataOf(kind, row);
  return parsed === undefined ? payload : JSON.stringify(withJsonField(row, "data", parsed));
};

const trim = (streamId: StreamId, payload: string): string => {
  const kind = kindOfStream(streamId);
  return kind === undefined ? payload : trimmedPayload(kind, payload);
};

export const opencodeNormalizer: Normalizer = {
  id: "opencode",
  parserVersion: 4,
  conversationKeyOf,
  normalize,
  trim,
};

import {
  RecordKey,
  textOfParts,
  type MessagePart,
  type NormalizedConversation,
  type NormalizedMessage,
  type NormalizedToolExecution,
  type RawRecord,
  type SourceRecordRow,
  type StreamId,
} from "@aqt/turnstash-core";
import { Effect, FileSystem, Path, Result, Schema } from "effect";

const Markdown = Schema.Union([Schema.String, Schema.Struct({ value: Schema.String })]);
const ResponseFields = {
  value: Schema.optionalKey(Markdown),
  toolCallId: Schema.optionalKey(Schema.String),
  toolId: Schema.optionalKey(Schema.String),
  invocationMessage: Schema.optionalKey(Markdown),
};
const ResponsePart = Schema.Union([
  Schema.Struct({
    ...ResponseFields,
    kind: Schema.optionalKey(
      Schema.Literals(["thinking", "markdownContent", "toolInvocationSerialized"]),
    ),
  }),
  Schema.Struct({ kind: Schema.String }),
]);
const ChatRequest = Schema.Struct({
  requestId: Schema.optionalKey(Schema.String),
  message: Schema.Struct({ text: Schema.String }),
  response: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(ResponsePart)])),
  timestamp: Schema.optionalKey(Schema.Number),
  modelId: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(
    Schema.Struct({
      extensionId: Schema.optionalKey(
        Schema.Union([Schema.String, Schema.Struct({ value: Schema.String })]),
      ),
      extensionVersion: Schema.optionalKey(Schema.String),
    }),
  ),
});
const ChatSession = Schema.Struct({
  sessionId: Schema.String,
  creationDate: Schema.Number,
  lastMessageDate: Schema.optionalKey(Schema.Number),
  customTitle: Schema.optionalKey(Schema.String),
  responderUsername: Schema.optionalKey(Schema.String),
  requests: Schema.Array(ChatRequest),
});

const PathSegment = Schema.Union([
  Schema.String.check(
    Schema.makeFilter((key) => !["__proto__", "prototype", "constructor"].includes(key)),
  ),
  Schema.Natural,
]);
const JournalOperation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(0), v: Schema.MutableJson }),
  Schema.Struct({
    kind: Schema.Literal(1),
    k: Schema.Union([PathSegment, Schema.Array(PathSegment)]),
    v: Schema.optionalKey(Schema.MutableJson),
  }),
  Schema.Struct({
    kind: Schema.Literal(2),
    k: Schema.Union([PathSegment, Schema.Array(PathSegment)]),
    v: Schema.optionalKey(Schema.Array(Schema.MutableJson)),
    i: Schema.optionalKey(Schema.Natural),
  }),
  Schema.Struct({
    kind: Schema.Literal(3),
    k: Schema.Union([PathSegment, Schema.Array(PathSegment)]),
  }),
]);

const isObject = (value: Schema.MutableJson | undefined): value is Schema.MutableJsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const applyUpdate = (
  state: Schema.MutableJson,
  op: typeof JournalOperation.Type,
): Schema.MutableJson | undefined => {
  if (op.kind === 0) return op.v;
  const keys = typeof op.k === "string" || typeof op.k === "number" ? [op.k] : op.k;
  if (keys.length === 0) return op.kind === 1 ? op.v : undefined;
  let target: Schema.MutableJson | undefined = state;
  for (const key of keys.slice(0, -1)) {
    target =
      Array.isArray(target) && typeof key === "number"
        ? target[key]
        : isObject(target) && Object.hasOwn(target, key)
          ? target[String(key)]
          : undefined;
  }
  const key = keys[keys.length - 1];
  if (key === undefined || (!isObject(target) && !Array.isArray(target))) return undefined;
  if (Array.isArray(target) && typeof key !== "number") return undefined;
  let value: Schema.MutableJson | undefined = op.kind === 1 ? op.v : undefined;
  if (op.kind === 2) {
    const current =
      Array.isArray(target) && typeof key === "number"
        ? target[key]
        : isObject(target)
          ? target[String(key)]
          : undefined;
    const array = Array.isArray(current) ? current : [];
    if (op.i !== undefined) array.length = op.i;
    for (const item of op.v ?? []) array.push(item);
    value = array;
  }
  if (Array.isArray(target) && typeof key === "number") {
    if (value === undefined) delete target[key];
    else target[key] = value;
  } else if (isObject(target)) {
    if (value === undefined) delete target[String(key)];
    else target[String(key)] = value;
  }
  return state;
};

const readSession = Effect.fn("Copilot.readVscodeSession")(function* (absolutePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(absolutePath);
  if (!absolutePath.endsWith(".jsonl")) {
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ChatSession))(text);
  }
  let state: Schema.MutableJson | undefined = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const op = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JournalOperation))(line);
    state = applyUpdate(state, op);
    if (state === undefined) return yield* Schema.decodeUnknownEffect(ChatSession)(state);
  }
  return yield* Schema.decodeUnknownEffect(ChatSession)(state);
});

const Header = Schema.Struct({
  type: Schema.Literal("vscode.session"),
  sessionId: Schema.String,
  creationDate: Schema.Number,
  lastMessageDate: Schema.optionalKey(Schema.Number),
  customTitle: Schema.optionalKey(Schema.String),
  projectPath: Schema.optionalKey(Schema.String),
  requestIds: Schema.Array(Schema.String),
});
const Turn = Schema.Struct({ type: Schema.Literal("vscode.request"), request: ChatRequest });
const decodeHeader = Schema.decodeUnknownResult(Schema.fromJsonString(Header));
const decodeTurn = Schema.decodeUnknownResult(Schema.fromJsonString(Turn));
const Workspace = Schema.Struct({
  folder: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(Schema.String),
});

const extensionOf = (request: typeof ChatRequest.Type): string | undefined => {
  const id = request.agent?.extensionId;
  return typeof id === "string" ? id : id?.value;
};

export const readVscodeChat = Effect.fn("Copilot.readVscodeChat")(function* (
  streamId: StreamId,
  absolutePath: string,
) {
  const session = yield* readSession(absolutePath);
  const isCopilot = session.responderUsername === "GitHub Copilot";
  const requests = session.requests.filter((request) => {
    const extension = extensionOf(request)?.toLowerCase();
    return extension === "github.copilot-chat" || (extension === undefined && isCopilot);
  });
  if (!isCopilot && requests.length === 0) return [];
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceText = yield* fs
    .readFileString(path.join(path.dirname(absolutePath), "..", "workspace.json"))
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("{}")));
  const workspace = Schema.decodeUnknownResult(Schema.fromJsonString(Workspace))(workspaceText);
  const projectPath = Result.isSuccess(workspace)
    ? (workspace.success.folder ?? workspace.success.workspace)
    : undefined;
  const ids = requests.map((request, index) => request.requestId ?? `index:${index}`);
  const header: typeof Header.Type = {
    type: "vscode.session",
    sessionId: session.sessionId,
    creationDate: session.creationDate,
    ...(session.lastMessageDate === undefined ? {} : { lastMessageDate: session.lastMessageDate }),
    ...(session.customTitle === undefined ? {} : { customTitle: session.customTitle }),
    ...(projectPath === undefined ? {} : { projectPath }),
    requestIds: ids,
  };
  return [
    { streamId, recordKey: RecordKey.make("session"), payload: JSON.stringify(header) },
    ...requests.map((request, index): RawRecord => ({
      streamId,
      recordKey: RecordKey.make(`request:${ids[index]}`),
      payload: JSON.stringify({ type: "vscode.request", request }),
    })),
  ];
});

const isoOf = (milliseconds: number): string | undefined =>
  Number.isFinite(milliseconds) && milliseconds >= 1_000_000_000_000 && milliseconds <= 8.64e15
    ? new Date(milliseconds).toISOString()
    : undefined;
const textOf = (value: typeof Markdown.Type | undefined): string | undefined =>
  typeof value === "string" ? value : value?.value;

export const normalizeVscodeChat = (
  conversationKey: string,
  records: ReadonlyArray<SourceRecordRow>,
): NormalizedConversation | null => {
  const latest = new Map<string, SourceRecordRow>();
  for (const record of records) {
    const previous = latest.get(record.recordKey);
    if (previous === undefined || record.observedAt > previous.observedAt)
      latest.set(record.recordKey, record);
  }
  const header = decodeHeader(latest.get("session")?.payload);
  if (Result.isFailure(header)) return null;
  const session = header.success;
  const startedAt = isoOf(session.creationDate);
  if (startedAt === undefined) return null;
  const messages: Array<NormalizedMessage> = [];
  const tools: Array<NormalizedToolExecution> = [];
  let clientVersion: string | undefined;
  let endedAt = startedAt;
  const pushMessage = (
    messageKey: string,
    role: NormalizedMessage["role"],
    createdAt: string,
    parts: ReadonlyArray<MessagePart>,
  ) => {
    const parent = messages.at(-1)?.messageKey;
    messages.push({
      messageKey,
      seq: messages.length,
      role,
      createdAt,
      parts,
      text: textOfParts(parts),
      ...(parent === undefined ? {} : { parentMessageKey: parent }),
    });
    if (createdAt > endedAt) endedAt = createdAt;
  };
  for (const id of session.requestIds) {
    const turn = decodeTurn(latest.get(`request:${id}`)?.payload);
    if (Result.isFailure(turn)) continue;
    const request = turn.success.request;
    const createdAt =
      request.timestamp === undefined ? startedAt : (isoOf(request.timestamp) ?? startedAt);
    clientVersion = request.agent?.extensionVersion ?? clientVersion;
    pushMessage(`user:${id}`, "user", createdAt, [{ type: "text", text: request.message.text }]);
    const parts: Array<MessagePart> = [];
    if (typeof request.response === "string") parts.push({ type: "text", text: request.response });
    else
      for (const part of request.response ?? []) {
        const text = textOf("value" in part ? part.value : undefined);
        if (part.kind === "thinking" && text) parts.push({ type: "thinking", text });
        else if ((part.kind === undefined || part.kind === "markdownContent") && text)
          parts.push({ type: "text", text });
        else if (
          part.kind === "toolInvocationSerialized" &&
          ("toolId" in part || "toolCallId" in part || "invocationMessage" in part)
        ) {
          const toolKey = `tool:${id}:${part.toolCallId ?? parts.length}`;
          const name = part.toolId ?? "unknown";
          parts.push({ type: "tool_call", toolKey, name, input: null });
          const summary = textOf(part.invocationMessage);
          if (summary) parts.push({ type: "text", text: summary });
          tools.push({
            toolKey,
            messageKey: `assistant:${id}`,
            name,
            input: null,
            output: null,
            status: "unknown",
          });
        }
      }
    if (parts.length > 0) {
      if (request.modelId !== undefined)
        parts.unshift({ type: "opaque", kind: "model", data: request.modelId });
      pushMessage(`assistant:${id}`, "assistant", createdAt, parts);
    }
  }
  if (messages.length === 0) return null;
  const lastMessageAt =
    session.lastMessageDate === undefined ? undefined : isoOf(session.lastMessageDate);
  return {
    conversationKey,
    startedAt,
    endedAt: lastMessageAt !== undefined && lastMessageAt > endedAt ? lastMessageAt : endedAt,
    ...(session.customTitle === undefined ? {} : { title: session.customTitle }),
    ...(session.projectPath === undefined ? {} : { projectPath: session.projectPath }),
    ...(clientVersion === undefined ? {} : { clientVersion }),
    messages,
    toolExecutions: tools,
    requests: [],
  };
};

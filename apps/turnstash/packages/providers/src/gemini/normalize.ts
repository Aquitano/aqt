import {
  isJsonObject,
  isoTimestampOf,
  jsonArray as arrayOf,
  jsonString as stringOf,
  parseJsonObject,
  streamPartsOf as partsOfStream,
  textOfParts,
  type MessagePart,
  type NormalizedConversation,
  type NormalizedMessage,
  type NormalizedRequest,
  type NormalizedToolExecution,
  type Normalizer,
  type SourceRecordRow,
  type StreamId,
  type ToolStatus,
} from "@aqt/turnstash-core";
import { Option, type Schema } from "effect";

export const firstJsonObject = (text: string): Schema.JsonObject | undefined => {
  const whole = parseJsonObject(text);
  if (whole !== undefined) return whole;
  for (const line of text.split("\n", 8)) {
    if (line.trim() === "") continue;
    return parseJsonObject(line);
  }
  return undefined;
};

const countOf = (value: Schema.Json | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

const minimumEpochMs = 1_000_000_000_000;
const maximumEpochMs = Date.parse("9999-12-31T23:59:59.999Z");

const isoOf = (value: Schema.Json | undefined): string | undefined => {
  const text = stringOf(value);
  if (text === undefined) return undefined;
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds) &&
    milliseconds >= minimumEpochMs &&
    milliseconds <= maximumEpochMs
    ? isoTimestampOf(milliseconds)
    : undefined;
};

const laterIso = (a: string, b: string | undefined): string =>
  b !== undefined && Date.parse(b) > Date.parse(a) ? b : a;

// Two CLI generations emit the same tools under different casings; one archive
// name keeps them counted together.
const toolNames: ReadonlyMap<string, string> = new Map(
  Object.entries({
    read_file: "Read",
    ReadFile: "Read",
    write_file: "Write",
    WriteFile: "Write",
    create_file: "Write",
    edit_file: "Edit",
    EditFile: "Edit",
    delete_file: "Delete",
    list_dir: "LS",
    ListDir: "LS",
    grep_search: "Grep",
    search_files: "Grep",
    SearchText: "Grep",
    find_files: "Glob",
    run_command: "Bash",
    Shell: "Bash",
    web_search: "WebSearch",
  }),
);

const toolStatusOf = (value: Schema.Json | undefined): ToolStatus => {
  const status = stringOf(value)?.toLowerCase();
  if (status === "success" || status === "completed" || status === "ok") return "ok";
  if (status === "error" || status === "failed") return "error";
  return "unknown";
};

// streamIdOf encodes `<root hash>/<kind>/<relative path>`; dropping the root
// hash is what lets two machines with different home directories agree on a key.
const streamPartsOf = (streamId: StreamId) => {
  const stream = partsOfStream(streamId);
  return stream?.relativePath ? stream : null;
};

const conversationKeyOf = (streamId: StreamId, payload: string): Option.Option<string> => {
  const value = firstJsonObject(payload);
  if (value === undefined) return Option.none();
  const stream = streamPartsOf(streamId);
  // A JSONL message line carries no sessionId, so every line of one file is
  // keyed by the file instead, or the file's records would never meet.
  if (stream !== null && stream.kind === "jsonl") return Option.some(stream.relativePath);
  return Option.fromUndefinedOr(stringOf(value["sessionId"]) ?? stream?.relativePath);
};

interface HeaderState {
  projectHash: string | undefined;
  startTime: string | undefined;
  lastUpdated: string | undefined;
}

const mergeHeader = (header: HeaderState, value: Schema.JsonObject): void => {
  header.projectHash ??= stringOf(value["projectHash"]);
  header.startTime ??= stringOf(value["startTime"]);
  const lastUpdated = stringOf(value["lastUpdated"]);
  if (lastUpdated !== undefined) header.lastUpdated = laterIso(lastUpdated, header.lastUpdated);
};

interface Candidate {
  readonly source: SourceRecordRow;
  readonly message: Omit<NormalizedMessage, "seq">;
  readonly tools: ReadonlyArray<NormalizedToolExecution>;
  readonly request: NormalizedRequest | null;
  readonly timestamped: boolean;
}

const partsOf = (
  raw: Schema.JsonObject,
  messageKey: string,
  createdAt: string,
): {
  readonly parts: ReadonlyArray<MessagePart>;
  readonly tools: ReadonlyArray<NormalizedToolExecution>;
} => {
  const parts: Array<MessagePart> = [];
  const tools: Array<NormalizedToolExecution> = [];
  const content = stringOf(raw["content"]);
  if (content !== undefined) parts.push({ type: "text", text: content });
  else {
    for (const item of arrayOf(raw["content"])) {
      const text = isJsonObject(item) ? stringOf(item["text"]) : stringOf(item);
      if (text !== undefined) parts.push({ type: "text", text });
    }
  }
  for (const thought of arrayOf(raw["thoughts"])) {
    const text = stringOf(thought);
    if (text !== undefined) {
      parts.push({ type: "thinking", text });
      continue;
    }
    if (!isJsonObject(thought)) continue;
    const summary = [
      stringOf(thought["subject"]),
      stringOf(thought["description"]) ?? stringOf(thought["text"]),
    ]
      .flatMap((piece) => (piece === undefined ? [] : [piece]))
      .join("\n");
    parts.push(
      summary === ""
        ? { type: "opaque", kind: "gemini_thought", data: thought }
        : { type: "thinking", text: summary },
    );
  }
  arrayOf(raw["toolCalls"]).forEach((call, position) => {
    if (!isJsonObject(call)) return;
    const reported = stringOf(call["displayName"]) ?? stringOf(call["name"]) ?? "tool";
    const name = toolNames.get(reported) ?? reported;
    const toolKey = stringOf(call["id"]) ?? `${messageKey}:tool-${position}`;
    const input = call["args"] ?? null;
    parts.push({ type: "tool_call", toolKey, name, input });
    tools.push({
      toolKey,
      messageKey,
      name,
      input,
      output: null,
      status: toolStatusOf(call["status"]),
      startedAt: createdAt,
    });
  });
  const tokens = raw["tokens"];
  // The API counts tool prompt tokens on their own; nobody has confirmed
  // whether promptTokenCount already contains them, so they stay out of usage.
  const toolTokens = isJsonObject(tokens) ? countOf(tokens["tool"]) : 0;
  if (toolTokens > 0)
    parts.push({ type: "opaque", kind: "gemini_tool_prompt_tokens", data: toolTokens });
  return { parts, tools };
};

const requestOf = (
  raw: Schema.JsonObject,
  messageKey: string,
  header: HeaderState,
  recordKey: string,
): NormalizedRequest | null => {
  const tokens = raw["tokens"];
  const model = stringOf(raw["model"]);
  if (!isJsonObject(tokens) || model === undefined) return null;
  const input = countOf(tokens["input"]);
  const output = countOf(tokens["output"]);
  const cached = countOf(tokens["cached"]);
  const thoughts = countOf(tokens["thoughts"]);
  if (input === 0 && output === 0 && cached === 0 && thoughts === 0) return null;
  // A timestamp that is present but unparseable drops the call, while a missing
  // one falls back to the session start.
  const timestamp = stringOf(raw["timestamp"]);
  const requestedAt = timestamp === undefined ? isoOf(header.startTime) : isoOf(timestamp);
  if (requestedAt === undefined) return null;
  return {
    requestKey: messageKey,
    messageKey,
    modelRaw: model,
    requestedAt,
    usage: {
      // Google reports the cached slice inside promptTokenCount, and bills
      // thoughts at the output rate outside candidatesTokenCount.
      inputTokens: Math.max(0, input - cached),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: output + thoughts,
      reasoningTokens: thoughts,
    },
    usageBasis: "reported",
    sourceRecordKey: recordKey,
  };
};

const roles = { user: "user", gemini: "assistant", info: "system" } as const;

const candidateOf = (
  raw: Schema.JsonObject,
  messageKey: string,
  header: HeaderState,
  record: SourceRecordRow,
): Candidate => {
  const type = stringOf(raw["type"]);
  const role = type === "user" || type === "gemini" || type === "info" ? roles[type] : "system";
  const timestamp = isoOf(raw["timestamp"]);
  const createdAt = timestamp ?? isoOf(header.startTime) ?? record.observedAt;
  const { parts, tools } = partsOf(raw, messageKey, createdAt);
  return {
    source: record,
    message: { messageKey, role, createdAt, parts, text: textOfParts(parts) },
    tools,
    request: role === "assistant" ? requestOf(raw, messageKey, header, record.recordKey) : null,
    timestamped: timestamp !== undefined,
  };
};

const isLaterCandidate = (seen: Candidate, candidate: Candidate): boolean => {
  // Preserve the recovery of a valid timestamp even if another copy is malformed.
  if (seen.timestamped !== candidate.timestamped) return candidate.timestamped;
  const left = Number(seen.source.recordKey);
  const right = Number(candidate.source.recordKey);
  const ordered = Number.isFinite(left) && Number.isFinite(right) && left !== right;
  if (seen.source.streamId === candidate.source.streamId && ordered) return right > left;
  if (seen.source.observedAt !== candidate.source.observedAt)
    return candidate.source.observedAt > seen.source.observedAt;
  if (ordered) return right > left;
  return candidate.source.payload >= seen.source.payload;
};

const streamsOf = (
  records: ReadonlyArray<SourceRecordRow>,
): ReadonlyArray<ReadonlyArray<SourceRecordRow>> => {
  const byStream = new Map<string, Array<SourceRecordRow>>();
  for (const record of records) {
    const stream = byStream.get(record.streamId);
    if (stream === undefined) byStream.set(record.streamId, [record]);
    else stream.push(record);
  }
  return [...byStream.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, stream]) =>
      [...stream].sort((a, b) => {
        const left = Number(a.recordKey);
        const right = Number(b.recordKey);
        return Number.isFinite(left) && Number.isFinite(right)
          ? left - right
          : a.recordKey.localeCompare(b.recordKey);
      }),
    );
};

const collectStream = (
  stream: ReadonlyArray<SourceRecordRow>,
  header: HeaderState,
  candidates: Map<string, Candidate>,
): void => {
  let geminiOrdinal = 0;
  let index = 0;
  const addMessage = (value: Schema.Json, record: SourceRecordRow): void => {
    if (!isJsonObject(value)) return;
    const type = stringOf(value["type"]) ?? "info";
    const position = index;
    index += 1;
    const fallback = type === "gemini" ? `idx-${geminiOrdinal}` : `${type}-${position}`;
    if (type === "gemini") geminiOrdinal += 1;
    const messageKey = stringOf(value["id"]) ?? fallback;
    const candidate = candidateOf(value, messageKey, header, record);
    const seen = candidates.get(messageKey);
    if (seen === undefined || isLaterCandidate(seen, candidate))
      candidates.set(messageKey, candidate);
  };
  for (const record of stream) {
    const whole = parseJsonObject(record.payload);
    // A JSONL file that was mistaken for a single document still normalizes.
    const values = whole === undefined ? record.payload.split("\n").map(parseJsonObject) : [whole];
    for (const value of values) {
      if (value === undefined) continue;
      const set = value["$set"];
      if (isJsonObject(set)) {
        mergeHeader(header, set);
        continue;
      }
      const messages = value["messages"];
      if (Array.isArray(messages)) {
        mergeHeader(header, value);
        for (const message of arrayOf(messages)) addMessage(message, record);
        continue;
      }
      if (stringOf(value["type"]) !== undefined) addMessage(value, record);
      else mergeHeader(header, value);
    }
  }
};

const titleOf = (messages: ReadonlyArray<NormalizedMessage>): string | undefined => {
  const first = messages.find((message) => message.role === "user");
  const text = first?.text.replace(/\s+/g, " ").trim() ?? "";
  return text === "" ? undefined : text.slice(0, 120);
};

const normalize = (
  conversationKey: string,
  records: ReadonlyArray<SourceRecordRow>,
): NormalizedConversation | null => {
  const header: HeaderState = {
    projectHash: undefined,
    startTime: undefined,
    lastUpdated: undefined,
  };
  const candidates = new Map<string, Candidate>();
  const streams = streamsOf(records);
  for (const stream of streams) collectStream(stream, header, candidates);
  const collected = [...candidates.values()];
  if (collected.length === 0) return null;

  const messages = collected.map((candidate, seq): NormalizedMessage => ({
    ...candidate.message,
    seq,
  }));
  const toolExecutions = new Map<string, NormalizedToolExecution>();
  for (const candidate of collected) {
    for (const tool of candidate.tools)
      if (!toolExecutions.has(tool.toolKey)) toolExecutions.set(tool.toolKey, tool);
  }
  const requests = collected.flatMap((candidate) =>
    candidate.request === null ? [] : [candidate.request],
  );

  const first = messages[0];
  if (first === undefined) return null;
  const oldest = streams[0]?.[0];
  const startedAt = isoOf(header.startTime) ?? first.createdAt;
  const endedAt = messages.reduce(
    (latest, message) => laterIso(latest, message.createdAt),
    startedAt,
  );
  const title = titleOf(messages);
  const project =
    header.projectHash ??
    (oldest === undefined ? undefined : streamPartsOf(oldest.streamId)?.relativePath.split("/")[0]);

  return {
    conversationKey,
    ...(title === undefined ? {} : { title }),
    ...(project === undefined || project === "" ? {} : { projectPath: project }),
    startedAt,
    endedAt: laterIso(endedAt, isoOf(header.lastUpdated)),
    messages,
    toolExecutions: [...toolExecutions.values()],
    requests,
  };
};

export const geminiNormalizer: Normalizer = {
  id: "gemini",
  parserVersion: 2,
  conversationKeyOf,
  normalize,
};

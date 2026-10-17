import {
  isJsonObject,
  isoTimestampOf,
  jsonArrayAt as arrayAt,
  jsonObjectAt as objectAt,
  jsonStringAt as stringAt,
  parseJsonObject,
  sqliteTableOf,
  streamPartsOf,
  addUsage,
  emptyUsage,
  sha256Hex,
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
import { normalizeVscodeChat } from "./vscode.ts";

const natural = (value: Schema.Json | undefined): number => {
  const numeric = typeof value === "string" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric) && numeric > 0
    ? Math.floor(numeric)
    : 0;
};

const rowIdOf = (value: Schema.Json | undefined): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

const isoOf = (value: Schema.Json | undefined): string | null => {
  if (typeof value === "number") return isoTimestampOf(value) ?? null;
  if (typeof value !== "string" || value === "") return null;
  const withZone = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return isoTimestampOf(withZone) ?? null;
};

type StreamKind =
  | { readonly kind: "vscode"; readonly sessionId: string }
  | { readonly kind: "jsonl"; readonly sessionId: string }
  | { readonly kind: "sqlite"; readonly table: string };

const streamKindOf = (streamId: string): StreamKind | null => {
  const stream = streamPartsOf(streamId);
  const segments = stream?.relativePath.split("/") ?? [];
  if (stream?.kind === "json" && segments[segments.length - 2] === "chatSessions") {
    const file = segments[segments.length - 1];
    return file !== undefined && /\.jsonl?$/.test(file)
      ? { kind: "vscode", sessionId: `vscode:${file.replace(/\.jsonl?$/, "")}` }
      : null;
  }
  if (stream?.kind === "jsonl") {
    if (segments.length === 1 && segments[0]?.endsWith(".jsonl")) {
      return { kind: "jsonl", sessionId: segments[0].slice(0, -6) };
    }
    const sessionId = segments[segments.length - 2];
    return segments.length >= 2 &&
      segments[segments.length - 1] === "events.jsonl" &&
      sessionId !== undefined
      ? { kind: "jsonl", sessionId }
      : null;
  }
  const table = sqliteTableOf(stream);
  return table === undefined ? null : { kind: "sqlite", table };
};

const sessionColumns: Readonly<Record<string, string>> = {
  assistant_usage_events: "session_id",
  turns: "session_id",
  sessions: "id",
};

const conversationKeyOf = (streamId: StreamId, payload: string): Option.Option<string> => {
  const stream = streamKindOf(streamId);
  if (stream === null) return Option.none();
  if (stream.kind === "jsonl" || stream.kind === "vscode") return Option.some(stream.sessionId);
  const column = sessionColumns[stream.table];
  if (column === undefined) return Option.none();
  const key = stringAt(parseJsonObject(payload), column);
  return key === undefined ? Option.none() : Option.some(key);
};

interface JournalEvent {
  readonly type: string;
  readonly id: string;
  readonly timestamp: string | null;
  readonly data: Schema.JsonObject;
  readonly recordKey: string;
}

interface UsageRow {
  readonly id: string;
  readonly signature: string;
  readonly model: string | undefined;
  readonly createdAt: string | null;
  readonly compaction: boolean;
  readonly usage: Usage;
}

interface TurnRow {
  readonly id: string;
  readonly index: number;
  readonly user: string | undefined;
  readonly assistant: string | undefined;
  readonly timestamp: string | null;
}

interface SessionRow {
  readonly cwd: string | undefined;
  readonly repository: string | undefined;
  readonly branch: string | undefined;
  readonly summary: string | undefined;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

interface DraftRequest {
  readonly requestKey: string;
  readonly messageKey: string | undefined;
  modelRaw: string | undefined;
  readonly requestedAt: string;
  readonly millis: number;
  usage: Usage;
  readonly usageBasis: "reported" | "cumulative_delta";
  readonly sourceRecordKey: string | undefined;
}

interface Leg {
  readonly millis: number;
  readonly timestamp: string;
  readonly compactionMillis: number | null;
  readonly metrics: ReadonlyMap<string, Usage>;
}

const compareKeys = (left: string, right: string): number => {
  const a = Number(left);
  const b = Number(right);
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
  return left < right ? -1 : left > right ? 1 : 0;
};

const compareRecords = (a: SourceRecordRow, b: SourceRecordRow): number =>
  a.streamId === b.streamId
    ? compareKeys(a.recordKey, b.recordKey)
    : a.streamId < b.streamId
      ? -1
      : 1;

const subtract = (from: Usage, taken: Usage): Usage => ({
  inputTokens: Math.max(0, from.inputTokens - taken.inputTokens),
  cacheReadTokens: Math.max(0, from.cacheReadTokens - taken.cacheReadTokens),
  cacheWriteTokens: Math.max(0, from.cacheWriteTokens - taken.cacheWriteTokens),
  cacheWrite1hTokens: Math.max(0, from.cacheWrite1hTokens - taken.cacheWrite1hTokens),
  outputTokens: Math.max(0, from.outputTokens - taken.outputTokens),
  reasoningTokens: Math.max(0, from.reasoningTokens - taken.reasoningTokens),
});

const isEmptyUsage = (usage: Usage): boolean =>
  usage.inputTokens === 0 &&
  usage.cacheReadTokens === 0 &&
  usage.cacheWriteTokens === 0 &&
  usage.outputTokens === 0 &&
  usage.reasoningTokens === 0;

const excludeCache = (inclusiveInput: number, cacheRead: number, cacheWrite: number): number =>
  Math.max(0, inclusiveInput - cacheRead - cacheWrite);

const attachmentPart = (value: Schema.Json): MessagePart | null => {
  if (!isJsonObject(value)) return null;
  const mediaType = stringAt(value, "mediaType", "mimeType");
  if (mediaType !== undefined && mediaType.startsWith("image/")) {
    const bytes = natural(value["bytes"] ?? value["size"]);
    return { type: "image", mediaType, ...(bytes > 0 ? { bytes } : {}) };
  }
  return { type: "opaque", kind: "attachment", data: value };
};

const usageOfRow = (row: Schema.JsonObject): Usage => {
  const cacheRead = natural(row["cache_read_tokens"]);
  const cacheWrite = natural(row["cache_write_tokens"]);
  return {
    inputTokens: excludeCache(natural(row["input_tokens"]), cacheRead, cacheWrite),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheWrite1hTokens: 0,
    outputTokens: natural(row["output_tokens"]),
    reasoningTokens: natural(row["reasoning_tokens"]),
  };
};

const legMetricsOf = (data: Schema.JsonObject): ReadonlyMap<string, Usage> => {
  const metrics = new Map<string, Usage>();
  for (const [model, value] of Object.entries(objectAt(data, "modelMetrics") ?? {})) {
    if (!isJsonObject(value)) continue;
    const usage = objectAt(value, "usage");
    metrics.set(model, {
      inputTokens: natural(usage?.["inputTokens"]),
      cacheReadTokens: natural(usage?.["cacheReadTokens"]),
      cacheWriteTokens: natural(usage?.["cacheWriteTokens"]),
      cacheWrite1hTokens: 0,
      outputTokens: natural(usage?.["outputTokens"]),
      reasoningTokens: natural(usage?.["reasoningTokens"]),
    });
  }
  return metrics;
};

const legDelta = (cumulative: Usage, previous: Usage | undefined): Usage => {
  if (previous === undefined) return cumulative;
  const reset =
    cumulative.inputTokens < previous.inputTokens ||
    cumulative.cacheReadTokens < previous.cacheReadTokens ||
    cumulative.cacheWriteTokens < previous.cacheWriteTokens ||
    cumulative.outputTokens < previous.outputTokens ||
    cumulative.reasoningTokens < previous.reasoningTokens;
  return reset ? cumulative : subtract(cumulative, previous);
};

const pairingWindowMillis = 120_000;

const toMessage = (
  messageKey: string,
  seq: number,
  role: NormalizedMessage["role"],
  parentMessageKey: string | undefined,
  createdAt: string,
  parts: ReadonlyArray<MessagePart>,
): NormalizedMessage => ({
  messageKey,
  seq,
  role,
  ...(parentMessageKey === undefined ? {} : { parentMessageKey }),
  createdAt,
  parts,
  text: textOfParts(parts),
});

const rowRequest = (row: UsageRow & { readonly createdAt: string }): DraftRequest => ({
  requestKey: `store:${row.id}:${row.signature}`,
  messageKey: undefined,
  modelRaw: row.model,
  requestedAt: row.createdAt,
  millis: Date.parse(row.createdAt),
  usage: row.usage,
  usageBasis: "reported",
  sourceRecordKey: row.id,
});

const toRequest = (draft: DraftRequest): NormalizedRequest => ({
  requestKey: draft.requestKey,
  ...(draft.messageKey === undefined ? {} : { messageKey: draft.messageKey }),
  modelRaw: draft.modelRaw ?? "unknown",
  requestedAt: draft.requestedAt,
  usage: draft.usage,
  usageBasis: draft.usageBasis,
  ...(draft.sourceRecordKey === undefined ? {} : { sourceRecordKey: draft.sourceRecordKey }),
});

interface JournalRows {
  readonly events: ReadonlyArray<JournalEvent>;
  readonly usageRows: ReadonlyMap<string, UsageRow>;
  readonly turns: ReadonlyMap<string, TurnRow>;
  readonly session: SessionRow | null;
}

type StampedEvent = JournalEvent & { readonly timestamp: string };

const readRows = (records: ReadonlyArray<SourceRecordRow>): JournalRows => {
  const events: Array<JournalEvent> = [];
  const seenEvents = new Set<string>();
  const usageRows = new Map<string, UsageRow>();
  const turns = new Map<string, TurnRow>();
  let session: SessionRow | null = null;

  for (const record of [...records].sort(compareRecords)) {
    const stream = streamKindOf(record.streamId);
    if (stream === null) continue;
    if (stream.kind === "vscode") continue;
    const payload = parseJsonObject(record.payload);
    if (payload === undefined) continue;
    if (stream.kind === "jsonl") {
      const type = stringAt(payload, "type");
      if (type === undefined) continue;
      const id = stringAt(payload, "id");
      const dedupeKey = `${type}:${id ?? record.payload}`;
      if (seenEvents.has(dedupeKey)) continue;
      seenEvents.add(dedupeKey);
      events.push({
        type,
        id: id ?? `${record.streamId}:${record.recordKey}`,
        timestamp: isoOf(payload["timestamp"]),
        data: objectAt(payload, "data") ?? {},
        recordKey: record.recordKey,
      });
      continue;
    }
    if (stream.table === "assistant_usage_events") {
      const model = stringAt(payload, "model");
      const usage = usageOfRow(payload);
      const signature = sha256Hex(
        [
          stringAt(payload, "created_at") ?? "",
          usage.inputTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
          usage.reasoningTokens,
          model ?? "",
        ].join("|"),
      ).slice(0, 16);
      const id = rowIdOf(payload["id"]);
      usageRows.set(`${id}:${signature}`, {
        id,
        signature,
        model,
        createdAt: isoOf(payload["created_at"]),
        compaction: stringAt(payload, "initiator") === "compaction",
        usage,
      });
      continue;
    }
    if (stream.table === "turns") {
      const id = rowIdOf(payload["id"]);
      turns.set(id, {
        id,
        index: natural(payload["turn_index"]),
        user: stringAt(payload, "user_message"),
        assistant: stringAt(payload, "assistant_response"),
        timestamp: isoOf(payload["timestamp"]),
      });
      continue;
    }
    if (stream.table === "sessions") {
      session = {
        cwd: stringAt(payload, "cwd"),
        repository: stringAt(payload, "repository"),
        branch: stringAt(payload, "branch"),
        summary: stringAt(payload, "summary"),
        createdAt: isoOf(payload["created_at"]),
        updatedAt: isoOf(payload["updated_at"]),
      };
    }
  }
  return { events, usageRows, turns, session };
};

const stampedEvents = (events: ReadonlyArray<JournalEvent>): ReadonlyArray<StampedEvent> => {
  const stamped: Array<StampedEvent> = [];
  let carried: string | null = null;
  for (const event of events) {
    carried = event.timestamp ?? carried;
    if (carried !== null) stamped.push({ ...event, timestamp: carried });
  }
  return stamped.sort((a, b) =>
    a.timestamp === b.timestamp
      ? compareKeys(a.recordKey, b.recordKey)
      : a.timestamp < b.timestamp
        ? -1
        : 1,
  );
};

const pairUsageRows = (
  drafts: ReadonlyArray<DraftRequest>,
  usageRows: ReadonlyMap<string, UsageRow>,
  fallbackStamp: string | null,
): ReadonlyArray<DraftRequest> => {
  const stampedRows: Array<UsageRow & { readonly createdAt: string }> = [];
  let carriedStamp: string | null = null;
  for (const row of usageRows.values()) {
    if (row.createdAt !== null) carriedStamp = row.createdAt;
    const createdAt = row.createdAt ?? carriedStamp ?? fallbackStamp;
    if (createdAt !== null) stampedRows.push({ ...row, createdAt });
  }
  stampedRows.sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || compareKeys(a.id, b.id),
  );

  const billed: Array<DraftRequest> = drafts.map((draft) => ({ ...draft }));
  const journalByTime = [...billed].sort((a, b) => a.millis - b.millis);
  let cursor = 0;
  for (const row of stampedRows) {
    if (!row.compaction) {
      const millis = Date.parse(row.createdAt);
      let candidate = journalByTime[cursor];
      while (candidate !== undefined && candidate.millis < millis - pairingWindowMillis) {
        cursor += 1;
        candidate = journalByTime[cursor];
      }
      if (candidate !== undefined && candidate.millis - millis <= pairingWindowMillis) {
        candidate.usage = addUsage(candidate.usage, { ...row.usage, outputTokens: 0 });
        if (candidate.modelRaw === undefined) candidate.modelRaw = row.model;
        cursor += 1;
        continue;
      }
    }
    billed.push(rowRequest(row));
  }
  return billed;
};

const shutdownResiduals = (
  legs: ReadonlyArray<Leg>,
  billed: ReadonlyArray<DraftRequest>,
): ReadonlyArray<DraftRequest> => {
  const residuals: Array<DraftRequest> = [];
  const cumulative = new Map<string, Usage>();
  let previousLegMillis: number | null = null;
  legs
    .slice()
    .sort((a, b) => a.millis - b.millis)
    .forEach((leg, index) => {
      const start = leg.compactionMillis ?? previousLegMillis;
      for (const [model, metrics] of leg.metrics) {
        const delta = legDelta(metrics, cumulative.get(model));
        cumulative.set(model, metrics);
        const claimed: Usage = {
          ...delta,
          inputTokens: excludeCache(
            delta.inputTokens,
            delta.cacheReadTokens,
            delta.cacheWriteTokens,
          ),
        };
        const covered = billed.reduce(
          (total, draft) =>
            draft.modelRaw === model &&
            draft.millis <= leg.millis &&
            (start === null || draft.millis > start)
              ? addUsage(total, draft.usage)
              : total,
          emptyUsage,
        );
        const residual = subtract(claimed, covered);
        if (isEmptyUsage(residual)) continue;
        residuals.push({
          requestKey: `shutdown:${model}:${index}`,
          messageKey: undefined,
          modelRaw: model,
          requestedAt: leg.timestamp,
          millis: leg.millis,
          usage: residual,
          usageBasis: "cumulative_delta",
          sourceRecordKey: undefined,
        });
      }
      previousLegMillis = leg.millis;
    });
  return residuals;
};

const normalize = (
  conversationKey: string,
  records: ReadonlyArray<SourceRecordRow>,
): NormalizedConversation | null => {
  if (conversationKey.startsWith("vscode:")) return normalizeVscodeChat(conversationKey, records);
  const { events, usageRows, turns, session } = readRows(records);
  const stamped = stampedEvents(events);

  const messages: Array<NormalizedMessage> = [];
  const tools = new Map<string, ToolDraft>();
  const drafts: Array<DraftRequest> = [];
  const legs: Array<Leg> = [];
  const modelSignals: Array<{ readonly position: number; readonly model: string }> = [];
  const requestPositions = new Map<string, number>();
  let modelBeforeFirstChange: string | undefined;
  let shutdownModel: string | undefined;
  let projectPath: string | undefined;
  let gitBranch: string | undefined;
  let clientVersion: string | undefined;
  let startTime: string | null = null;
  let previousMessageKey: string | undefined;
  let assistantMessageKey: string | undefined;
  let compactionMillis: number | null = null;

  const pushMessage = (
    messageKey: string,
    role: NormalizedMessage["role"],
    createdAt: string,
    parts: ReadonlyArray<MessagePart>,
  ) => {
    messages.push(
      toMessage(messageKey, messages.length, role, previousMessageKey, createdAt, parts),
    );
    previousMessageKey = messageKey;
  };

  stamped.forEach((event, position) => {
    const data = event.data;
    switch (event.type) {
      case "session.start": {
        const context = objectAt(data, "context");
        projectPath = stringAt(context, "cwd") ?? projectPath;
        gitBranch = stringAt(context, "branch") ?? gitBranch;
        clientVersion = stringAt(data, "copilotVersion") ?? clientVersion;
        startTime = isoOf(data["startTime"]) ?? startTime;
        const model = stringAt(data, "selectedModel");
        if (model !== undefined) modelSignals.push({ position, model });
        return;
      }
      case "session.model_change": {
        const model = stringAt(data, "newModel");
        if (modelBeforeFirstChange === undefined)
          modelBeforeFirstChange = stringAt(data, "previousModel");
        if (model !== undefined) modelSignals.push({ position, model });
        return;
      }
      case "user.message": {
        const parts: Array<MessagePart> = [];
        const content = stringAt(data, "content");
        if (content !== undefined) parts.push({ type: "text", text: content });
        for (const attachment of arrayAt(data, "attachments")) {
          const part = attachmentPart(attachment);
          if (part !== null) parts.push(part);
        }
        const interactionKey = `user:${stringAt(data, "interactionId") ?? event.id}`;
        // Invoking a skill adds a second user message, carrying the skill's context, to the interaction.
        const taken = messages.some((message) => message.messageKey === interactionKey);
        pushMessage(taken ? `user:${event.id}` : interactionKey, "user", event.timestamp, parts);
        return;
      }
      case "assistant.message": {
        const messageId = stringAt(data, "messageId") ?? event.id;
        const messageKey = `assistant:${messageId}`;
        const parts: Array<MessagePart> = [];
        const reasoning = stringAt(data, "reasoningText");
        if (reasoning !== undefined) parts.push({ type: "thinking", text: reasoning });
        const content = stringAt(data, "content");
        if (content !== undefined) parts.push({ type: "text", text: content });
        for (const request of arrayAt(data, "toolRequests")) {
          if (!isJsonObject(request)) continue;
          const toolCallId = stringAt(request, "toolCallId");
          if (toolCallId === undefined) continue;
          const toolKey = `tool:${toolCallId}`;
          const name = stringAt(request, "name", "toolName") ?? "unknown";
          const input = request["arguments"] ?? null;
          parts.push({ type: "tool_call", toolKey, name, input });
          const existing = tools.get(toolKey);
          tools.set(toolKey, {
            messageKey,
            name,
            input,
            output: existing?.output ?? null,
            status: existing?.status ?? "unknown",
            startedAt: existing?.startedAt ?? event.timestamp,
            endedAt: existing?.endedAt,
          });
        }
        pushMessage(messageKey, "assistant", event.timestamp, parts);
        assistantMessageKey = messageKey;
        const requestKey = `request:${messageId}`;
        requestPositions.set(requestKey, position);
        drafts.push({
          requestKey,
          messageKey,
          modelRaw: undefined,
          requestedAt: event.timestamp,
          millis: Date.parse(event.timestamp),
          usage: { ...emptyUsage, outputTokens: natural(data["outputTokens"]) },
          usageBasis: "reported",
          sourceRecordKey: event.recordKey,
        });
        return;
      }
      case "tool.execution_start": {
        const toolCallId = stringAt(data, "toolCallId");
        if (toolCallId === undefined) return;
        const toolKey = `tool:${toolCallId}`;
        const existing = tools.get(toolKey);
        tools.set(toolKey, {
          messageKey: assistantMessageKey,
          name: stringAt(data, "toolName") ?? existing?.name ?? "unknown",
          input: existing?.input ?? data["arguments"] ?? null,
          output: existing?.output ?? null,
          status: existing?.status ?? "unknown",
          startedAt: event.timestamp,
          endedAt: existing?.endedAt,
        });
        return;
      }
      case "tool.execution_complete": {
        const toolCallId = stringAt(data, "toolCallId");
        if (toolCallId === undefined) return;
        const toolKey = `tool:${toolCallId}`;
        const existing = tools.get(toolKey);
        const result = objectAt(data, "result");
        const output = stringAt(result, "detailedContent", "content") ?? null;
        const isError = data["success"] === false;
        tools.set(toolKey, {
          messageKey: existing?.messageKey ?? assistantMessageKey,
          name: existing?.name ?? stringAt(data, "toolName") ?? "unknown",
          input: existing?.input ?? null,
          output,
          status: isError ? "error" : "ok",
          startedAt: existing?.startedAt,
          endedAt: event.timestamp,
        });
        const model = stringAt(data, "model");
        if (model !== undefined) modelSignals.push({ position, model });
        pushMessage(`${toolKey}:result`, "tool", event.timestamp, [
          { type: "tool_result", toolKey, output, ...(isError ? { isError: true } : {}) },
        ]);
        return;
      }
      case "session.compaction_complete": {
        if (data["success"] !== true) return;
        compactionMillis = Date.parse(event.timestamp);
        pushMessage(`compaction:${event.id}`, "system", event.timestamp, [
          { type: "opaque", kind: "compaction", data },
        ]);
        return;
      }
      case "session.error": {
        const message = stringAt(data, "message") ?? "";
        pushMessage(`error:${event.id}`, "system", event.timestamp, [
          { type: "text", text: message },
          {
            type: "opaque",
            kind: "error",
            data: {
              errorType: stringAt(data, "errorType") ?? null,
              statusCode: natural(data["statusCode"]),
              providerCallId: stringAt(data, "providerCallId") ?? null,
            },
          },
        ]);
        return;
      }
      case "session.shutdown": {
        shutdownModel = stringAt(data, "currentModel") ?? shutdownModel;
        legs.push({
          millis: Date.parse(event.timestamp),
          timestamp: event.timestamp,
          compactionMillis,
          metrics: legMetricsOf(data),
        });
        compactionMillis = null;
        return;
      }
      default:
        return;
    }
  });

  const legModels = [...new Set(legs.flatMap((leg) => [...leg.metrics.keys()]))];
  const fallbackModel = shutdownModel ?? (legModels.length === 1 ? legModels[0] : undefined);

  for (const draft of drafts) {
    const position = requestPositions.get(draft.requestKey) ?? 0;
    const before = modelSignals.findLast((signal) => signal.position <= position);
    const after = modelSignals.find((signal) => signal.position > position);
    draft.modelRaw = before?.model ?? modelBeforeFirstChange ?? after?.model ?? fallbackModel;
  }

  const billed = pairUsageRows(drafts, usageRows, session?.createdAt ?? startTime);
  const requests = [...billed, ...shutdownResiduals(legs, billed)].map(toRequest);

  if (messages.length === 0) {
    for (const turn of [...turns.values()].sort(
      (a, b) => a.index - b.index || compareKeys(a.id, b.id),
    )) {
      const createdAt = turn.timestamp ?? session?.createdAt;
      if (createdAt === undefined || createdAt === null) continue;
      if (turn.user !== undefined) {
        pushMessage(`turn:${turn.id}:user`, "user", createdAt, [{ type: "text", text: turn.user }]);
      }
      if (turn.assistant !== undefined) {
        pushMessage(`turn:${turn.id}:assistant`, "assistant", createdAt, [
          { type: "text", text: turn.assistant },
        ]);
      }
    }
  }

  if (messages.length === 0 && requests.length === 0) return null;

  const toolExecutions: Array<NormalizedToolExecution> = [...tools.entries()].map(
    ([toolKey, tool]) => toolExecutionOf(toolKey, tool),
  );

  const stamps = [
    ...messages.map((message) => message.createdAt),
    ...requests.map((request) => request.requestedAt),
    ...(startTime === null ? [] : [startTime]),
    ...(session === null || session.createdAt === null ? [] : [session.createdAt]),
    ...(session === null || session.updatedAt === null ? [] : [session.updatedAt]),
  ].sort();
  const startedAt = stamps[0];
  const endedAt = stamps[stamps.length - 1];
  if (startedAt === undefined || endedAt === undefined) return null;

  const project = projectPath ?? session?.cwd ?? session?.repository;
  const branch = gitBranch ?? session?.branch;

  return {
    conversationKey,
    ...(session?.summary === undefined ? {} : { title: session.summary }),
    ...(project === undefined ? {} : { projectPath: project }),
    ...(branch === undefined ? {} : { gitBranch: branch }),
    ...(clientVersion === undefined ? {} : { clientVersion }),
    startedAt,
    endedAt,
    messages,
    toolExecutions,
    requests,
  };
};

export const copilotNormalizer: Normalizer = {
  id: "copilot",
  parserVersion: 4,
  conversationKeyOf,
  normalize,
};

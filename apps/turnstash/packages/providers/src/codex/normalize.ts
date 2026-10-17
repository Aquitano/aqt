import {
  isJsonArray as isArray,
  isJsonObject as isObject,
  isOmittedBlob,
  isoTimestampOf,
  jsonCount,
  jsonNumber as numberOf,
  jsonString as stringOf,
  parseJsonObject,
  textOfParts,
  type MessagePart,
  type NormalizedConversation,
  type NormalizedMessage,
  type NormalizedRequest,
  type Normalizer,
  type Role,
  type SourceRecordRow,
  type ToolStatus,
  type Usage,
  type UsageBasis,
} from "@aqt/turnstash-core";
import { Option, type Schema } from "effect";

import { toolExecutionOf, type ToolDraft } from "../tool-draft.ts";

const rolloutUuid =
  /rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const natural = (value: number): number => (value > 0 ? Math.trunc(value) : 0);

const isoOf = (value: Schema.Json | undefined): string | undefined =>
  isoTimestampOf(stringOf(value));

interface Envelope {
  readonly streamId: string;
  readonly recordKey: string;
  readonly ordinal: number | undefined;
  readonly key: string;
  readonly timestamp: string | undefined;
  readonly type: string;
  readonly payload: Schema.JsonObject;
}

const envelopeOf = (row: SourceRecordRow): Envelope | undefined => {
  const line = parseJsonObject(row.payload);
  if (line === undefined) return undefined;
  const type = stringOf(line["type"]);
  const ordinal = numberOf(line["ordinal"]);
  const payload = line["payload"];
  if (type === undefined || !isObject(payload)) return undefined;
  return {
    streamId: row.streamId,
    recordKey: row.recordKey,
    ordinal,
    key: ordinal === undefined ? `offset:${row.recordKey}` : `ordinal:${ordinal}`,
    timestamp: isoOf(line["timestamp"]),
    type,
    payload,
  };
};

const orderedEnvelopes = (records: ReadonlyArray<SourceRecordRow>): ReadonlyArray<Envelope> => {
  const envelopes = records.flatMap((row) => {
    const envelope = envelopeOf(row);
    return envelope === undefined ? [] : [envelope];
  });
  const hasOrdinals = envelopes.every((envelope) => envelope.ordinal !== undefined);
  envelopes.sort(
    (a, b) =>
      (hasOrdinals ? (a.ordinal ?? 0) - (b.ordinal ?? 0) : 0) ||
      Number(a.recordKey) - Number(b.recordKey) ||
      a.streamId.localeCompare(b.streamId),
  );
  const seen = new Set<string>();
  const unique: Array<Envelope> = [];
  for (const envelope of envelopes) {
    if (seen.has(envelope.key)) continue;
    seen.add(envelope.key);
    unique.push(envelope);
  }
  return unique;
};

const uniqueKey = (used: Set<string>, base: string): string => {
  let key = base;
  let suffix = 2;
  while (used.has(key)) {
    key = `${base}#${suffix}`;
    suffix += 1;
  }
  used.add(key);
  return key;
};

// Codex replays instructions and environment notes as user messages; they are context, not prompts.
const contextPrefix =
  /^\s*(?:<environment_context>|<user_instructions>|<turn_aborted>|<permissions_instructions>|# AGENTS\.md instructions)/;
const isContextMessage = (parts: ReadonlyArray<MessagePart>): boolean =>
  parts.every((part) => part.type === "text") &&
  parts.some((part) => part.type === "text" && contextPrefix.test(part.text));

const roleOf = (value: string | undefined): Role | undefined => {
  switch (value) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "developer":
    case "system":
      return "system";
    default:
      return undefined;
  }
};

const dataUri = /^data:([^;,]+)?(;base64)?,(.*)$/s;

const imagePartOf = (item: Schema.JsonObject): MessagePart => {
  const url = item["image_url"];
  if (isOmittedBlob(url))
    return {
      type: "image",
      ...(url.mediaType === undefined ? {} : { mediaType: url.mediaType }),
      bytes: url.bytes,
    };
  const match = dataUri.exec(stringOf(url) ?? "");
  const mediaType = match?.[1];
  const encoded = match?.[3];
  return {
    type: "image",
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(encoded === undefined
      ? {}
      : { bytes: natural(Math.floor((encoded.replace(/=+$/, "").length * 3) / 4)) }),
  };
};

const partsOfContent = (content: ReadonlyArray<Schema.Json>): ReadonlyArray<MessagePart> =>
  content.flatMap((item) => {
    if (!isObject(item)) return [];
    if (stringOf(item["type"]) === "input_image") return [imagePartOf(item)];
    const text = stringOf(item["text"]);
    return text === undefined ? [] : [{ type: "text" as const, text }];
  });

const summaryTextOf = (payload: Schema.JsonObject): string => {
  const summary = payload["summary"];
  return (isArray(summary) ? summary : [])
    .flatMap((item) => {
      const text = isObject(item) ? stringOf(item["text"]) : undefined;
      return text === undefined ? [] : [text];
    })
    .join("\n");
};

const outputTextOf = (value: Schema.Json | undefined): string | null => {
  if (typeof value === "string") return value;
  if (isArray(value)) {
    return value
      .flatMap((item) => {
        const text = isObject(item) ? stringOf(item["text"]) : undefined;
        return text === undefined ? [] : [text];
      })
      .join("\n");
  }
  return value === undefined || value === null ? null : JSON.stringify(value);
};

const statusOf = (value: Schema.Json | undefined, fallback: ToolStatus): ToolStatus => {
  switch (stringOf(value)) {
    case "completed":
    case "success":
      return "ok";
    case "failed":
    case "error":
    case "incomplete":
      return "error";
    default:
      return fallback;
  }
};

const toolNameOf = (payload: Schema.JsonObject): string => {
  const name = stringOf(payload["name"]) ?? "unknown";
  const namespace = stringOf(payload["namespace"]);
  return namespace !== undefined && namespace.startsWith("mcp__") ? `${namespace}__${name}` : name;
};

const usageFields = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
] as const;

const usageOf = (value: Schema.Json | undefined): Usage | undefined => {
  if (!isObject(value)) return undefined;
  const total = jsonCount(value["input_tokens"]);
  const cacheReadTokens = Math.min(jsonCount(value["cached_input_tokens"]), total);
  const cacheWriteTokens = Math.min(
    jsonCount(value["cache_write_input_tokens"]),
    total - cacheReadTokens,
  );
  return {
    inputTokens: total - cacheReadTokens - cacheWriteTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite1hTokens: 0,
    outputTokens: jsonCount(value["output_tokens"]),
    reasoningTokens: jsonCount(value["reasoning_output_tokens"]),
  };
};

const subtractTotals = (
  current: Schema.JsonObject,
  previous: Schema.JsonObject | undefined,
): Schema.JsonObject =>
  Object.fromEntries(
    usageFields.map((field) => [
      field,
      natural((numberOf(current[field]) ?? 0) - (numberOf(previous?.[field]) ?? 0)),
    ]),
  );

const parentKeyOf = (meta: Schema.JsonObject, conversationKey: string): string | undefined => {
  const source = meta["source"];
  const subagent = isObject(source) ? source["subagent"] : undefined;
  const spawn = isObject(subagent) ? subagent["thread_spawn"] : undefined;
  const parent =
    stringOf(meta["forked_from_id"]) ??
    stringOf(meta["parent_thread_id"]) ??
    (isObject(spawn) ? stringOf(spawn["parent_thread_id"]) : undefined) ??
    stringOf(meta["session_id"]);
  return parent === undefined || parent.toLowerCase() === conversationKey.toLowerCase()
    ? undefined
    : parent;
};

const replayWindowMs = 5_000;

const normalize = (
  conversationKey: string,
  records: ReadonlyArray<SourceRecordRow>,
): NormalizedConversation | null => {
  const envelopes = orderedEnvelopes(records);
  if (envelopes.length === 0) return null;

  const meta = envelopes.find((envelope) => envelope.type === "session_meta")?.payload;
  const times = envelopes.flatMap((envelope) =>
    envelope.timestamp === undefined ? [] : [envelope.timestamp],
  );
  const startedAt = times[0] ?? isoOf(meta?.["timestamp"]);
  const endedAt = times[times.length - 1] ?? startedAt;
  if (startedAt === undefined || endedAt === undefined) return null;

  const parentConversationKey = meta === undefined ? undefined : parentKeyOf(meta, conversationKey);
  const isOwnUsageRecord = (envelope: Envelope) => {
    const threadId = stringOf(envelope.payload["thread_id"]);
    return (
      envelope.type === "token_usage_record" &&
      (threadId === undefined || threadId.toLowerCase() === conversationKey.toLowerCase())
    );
  };
  const hasUsageRecords = envelopes.some(isOwnUsageRecord);
  const git = meta === undefined ? undefined : meta["git"];
  const routeHint = meta === undefined ? undefined : stringOf(meta["model_provider"]);

  // A fork replays the parent's history with fresh timestamps; without response ids there is
  // nothing else to tell a replayed usage record from one this thread paid for.
  const replayCutoff =
    parentConversationKey !== undefined && !hasUsageRecords
      ? Date.parse(isoOf(meta?.["timestamp"]) ?? startedAt) + replayWindowMs
      : undefined;

  const messages: Array<NormalizedMessage> = [];
  const messageKeys = new Set<string>();
  const tools = new Map<string, ToolDraft>();
  const requests: Array<NormalizedRequest> = [];
  const requestKeys = new Set<string>();

  let turnModel: string | undefined;
  let settingsModel: string | undefined;
  let lastAssistantKey: string | undefined;
  let previousInfo: string | undefined;
  let previousTotals: Schema.JsonObject | undefined;
  let previousTotalTokens: number | null = null;

  const pushMessage = (
    base: string,
    role: Role,
    createdAt: string,
    parts: ReadonlyArray<MessagePart>,
  ): string => {
    const messageKey = uniqueKey(messageKeys, base);
    messages.push({
      messageKey,
      seq: messages.length,
      role,
      createdAt,
      parts,
      text: textOfParts(parts),
    });
    if (role === "assistant") lastAssistantKey = messageKey;
    return messageKey;
  };

  const pushRequest = (
    requestKey: string,
    usage: Usage,
    usageBasis: UsageBasis,
    requestedAt: string,
    recordKey: string,
    infoModel: string | undefined,
  ) => {
    if (requestKeys.has(requestKey)) return;
    requestKeys.add(requestKey);
    requests.push({
      requestKey,
      ...(lastAssistantKey === undefined ? {} : { messageKey: lastAssistantKey }),
      modelRaw: turnModel ?? settingsModel ?? infoModel ?? "unknown",
      ...(routeHint === undefined ? {} : { routeHint }),
      requestedAt,
      usage,
      usageBasis,
      sourceRecordKey: recordKey,
    });
  };

  const openTool = (envelope: Envelope, at: string, name: string, input: Schema.Json) => {
    const toolKey = stringOf(envelope.payload["call_id"]) ?? envelope.key;
    const existing = tools.get(toolKey);
    if (existing !== undefined) {
      existing.name = name;
      existing.input = input;
      existing.status = statusOf(envelope.payload["status"], existing.status);
      return;
    }
    const messageKey = pushMessage(
      stringOf(envelope.payload["id"]) ?? envelope.key,
      "assistant",
      at,
      [{ type: "tool_call", toolKey, name, input }],
    );
    tools.set(toolKey, {
      messageKey,
      name,
      input,
      output: null,
      status: statusOf(envelope.payload["status"], "unknown"),
      startedAt: at,
      endedAt: undefined,
    });
  };

  const closeTool = (envelope: Envelope, at: string) => {
    const toolKey = stringOf(envelope.payload["call_id"]) ?? envelope.key;
    const output = outputTextOf(envelope.payload["output"]);
    const draft = tools.get(toolKey);
    const status = statusOf(envelope.payload["status"], draft?.status === "error" ? "error" : "ok");
    const messageKey = pushMessage(stringOf(envelope.payload["id"]) ?? envelope.key, "tool", at, [
      { type: "tool_result", toolKey, output, isError: status === "error" },
    ]);
    if (draft === undefined) {
      tools.set(toolKey, {
        messageKey,
        name: "unknown",
        input: null,
        output,
        status,
        startedAt: undefined,
        endedAt: at,
      });
      return;
    }
    draft.output = output;
    draft.status = status;
    draft.endedAt = at;
  };

  const handleResponseItem = (envelope: Envelope, at: string) => {
    const payload = envelope.payload;
    switch (stringOf(payload["type"])) {
      case "message": {
        const role = roleOf(stringOf(payload["role"]));
        const content = payload["content"];
        const parts = partsOfContent(isArray(content) ? content : []);
        if (role === undefined || parts.length === 0) return;
        pushMessage(
          stringOf(payload["id"]) ?? envelope.key,
          role === "user" && isContextMessage(parts) ? "system" : role,
          at,
          parts,
        );
        return;
      }
      case "reasoning": {
        const text = summaryTextOf(payload);
        if (text.length === 0) return;
        pushMessage(stringOf(payload["id"]) ?? envelope.key, "assistant", at, [
          { type: "thinking", text },
        ]);
        return;
      }
      case "function_call": {
        const args = stringOf(payload["arguments"]);
        const input = args === undefined ? null : (parseJsonObject(args) ?? args);
        openTool(envelope, at, toolNameOf(payload), input);
        return;
      }
      case "custom_tool_call": {
        openTool(envelope, at, toolNameOf(payload), stringOf(payload["input"]) ?? null);
        return;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        closeTool(envelope, at);
        return;
      }
      case "web_search_call": {
        openTool(envelope, at, "web_search", payload["action"] ?? null);
        return;
      }
    }
  };

  const handleTokenCount = (envelope: Envelope, at: string) => {
    const info = envelope.payload["info"];
    if (!isObject(info)) return;
    const serialized = JSON.stringify(info);
    if (serialized === previousInfo) return;
    const totals = isObject(info["total_token_usage"]) ? info["total_token_usage"] : undefined;
    const totalTokens = numberOf(totals?.["total_tokens"]);
    if (totalTokens !== undefined && totalTokens === previousTotalTokens) return;

    const last = info["last_token_usage"];
    const usage = isObject(last)
      ? usageOf(last)
      : totals === undefined
        ? undefined
        : usageOf(subtractTotals(totals, previousTotals));

    previousInfo = serialized;
    if (totals !== undefined) previousTotals = totals;
    if (totalTokens !== undefined) previousTotalTokens = totalTokens;
    if (usage === undefined) return;
    if (replayCutoff !== undefined && Date.parse(at) < replayCutoff) return;

    pushRequest(
      envelope.key,
      usage,
      isObject(last) ? "reported" : "cumulative_delta",
      at,
      envelope.recordKey,
      stringOf(info["model"]) ?? stringOf(info["model_name"]),
    );
  };

  for (const envelope of envelopes) {
    const at = envelope.timestamp ?? startedAt;
    switch (envelope.type) {
      case "turn_context": {
        turnModel = stringOf(envelope.payload["model"]) ?? turnModel;
        break;
      }
      case "response_item": {
        handleResponseItem(envelope, at);
        break;
      }
      case "event_msg": {
        const kind = stringOf(envelope.payload["type"]);
        if (kind === "thread_settings_applied") {
          const settings = envelope.payload["thread_settings"];
          settingsModel =
            (isObject(settings) ? stringOf(settings["model"]) : undefined) ?? settingsModel;
        } else if (kind === "token_count" && !hasUsageRecords) {
          handleTokenCount(envelope, at);
        }
        break;
      }
      case "token_usage_record": {
        if (!isOwnUsageRecord(envelope)) break;
        const usage = usageOf(envelope.payload["usage"]);
        if (usage === undefined) break;
        pushRequest(
          stringOf(envelope.payload["response_id"]) ?? envelope.key,
          usage,
          "reported",
          at,
          envelope.recordKey,
          undefined,
        );
        break;
      }
    }
  }

  const toolExecutions = [...tools].map(([toolKey, draft]) => toolExecutionOf(toolKey, draft));
  if (messages.length === 0 && toolExecutions.length === 0 && requests.length === 0) return null;

  const projectPath = meta === undefined ? undefined : stringOf(meta["cwd"]);
  const gitBranch = isObject(git) ? stringOf(git["branch"]) : undefined;
  const clientVersion = meta === undefined ? undefined : stringOf(meta["cli_version"]);

  return {
    conversationKey,
    ...(parentConversationKey === undefined ? {} : { parentConversationKey }),
    ...(projectPath === undefined ? {} : { projectPath }),
    ...(gitBranch === undefined ? {} : { gitBranch }),
    ...(clientVersion === undefined ? {} : { clientVersion }),
    startedAt,
    endedAt,
    messages,
    toolExecutions,
    requests,
  };
};

export const codexNormalizer: Normalizer = {
  id: "codex",
  parserVersion: 3,
  conversationKeyOf: (streamId) => {
    const uuid = rolloutUuid.exec(streamId)?.[1];
    return uuid === undefined ? Option.none() : Option.some(uuid.toLowerCase());
  },
  normalize,
};

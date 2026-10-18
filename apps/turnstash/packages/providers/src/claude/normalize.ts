import {
  isJsonArray as isArray,
  isOmittedBlob,
  isoTimestampOf,
  jsonArray as asArray,
  jsonCount as count,
  jsonObject as asObject,
  jsonString as asString,
  parseJsonObject,
  storedBlobOf,
  streamPartsOf,
  type MessagePart,
  type NormalizedConversation,
  type NormalizedMessage,
  type NormalizedRequest,
  type NormalizedToolExecution,
  type Normalizer,
  type RequestSpeed,
  type Role,
  type SourceRecordRow,
  type StreamId,
  textOfParts,
  type Usage,
} from "@aqt/turnstash-core";
import { Option, type Schema } from "effect";

import { toolExecutionOf, type ToolDraft } from "../tool-draft.ts";

type Json = Schema.Json;

const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const timestampOf = (value: Json | undefined, fallback: string): string => {
  const text = asString(value);
  if (text !== undefined && isoPattern.test(text)) return text;
  return isoTimestampOf(text) ?? fallback;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pathOfStream = (streamId: StreamId): string => {
  return streamPartsOf(streamId)?.relativePath ?? streamId;
};

const sessionOfPath = (path: string): string | undefined => {
  const segments = path.split("/");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const candidate = (segments[index] ?? "").replace(/\.(?:jsonl|meta\.json|json)$/, "");
    if (uuidPattern.test(candidate)) return candidate;
  }
  return undefined;
};

const conversationKeyOf = (streamId: StreamId, payload: string): Option.Option<string> => {
  const sessionId = asString(parseJsonObject(payload)?.["sessionId"]);
  if (sessionId !== undefined) return Option.some(sessionId);
  const fromPath = sessionOfPath(pathOfStream(streamId));
  return fromPath === undefined ? Option.none() : Option.some(fromPath);
};

interface Entry {
  readonly path: string;
  readonly offset: number;
  readonly recordKey: string;
  readonly observedAt: string;
  readonly record: Schema.JsonObject;
}

const orderedEntries = (records: ReadonlyArray<SourceRecordRow>): ReadonlyArray<Entry> =>
  records
    .flatMap((row): ReadonlyArray<Entry> => {
      const record = parseJsonObject(row.payload);
      if (record === undefined) return [];
      const offset = Number.parseInt(row.recordKey, 10);
      return [
        {
          path: pathOfStream(row.streamId),
          offset: Number.isFinite(offset) ? offset : 0,
          recordKey: row.recordKey,
          observedAt: row.observedAt,
          record,
        },
      ];
    })
    .sort((a, b) => (a.path === b.path ? a.offset - b.offset : a.path.localeCompare(b.path)));

interface MessageDraft {
  readonly messageKey: string;
  readonly role: Role;
  readonly path: string;
  readonly createdAt: string;
  readonly parentUuid: string | undefined;
  parentMessageKey: string | undefined;
  readonly parts: Array<MessagePart>;
}

interface RequestDraft {
  readonly messageKey: string;
  readonly requestedAt: string;
  model: string | undefined;
  usage: Schema.JsonObject | undefined;
  recordKey: string;
  advisorModel: string | undefined;
  synthetic: boolean;
}

const routeHintOf = (model: string): string | undefined => {
  const bedrock = /^(?:([a-z]+)\.)?anthropic\./.exec(model);
  if (bedrock !== null) return bedrock[1] === undefined ? "bedrock" : `bedrock-${bedrock[1]}`;
  return model.includes("@") ? "vertex" : undefined;
};

const speedOf = (usage: Schema.JsonObject | undefined): RequestSpeed | undefined => {
  const speed = asString(usage?.["speed"]);
  return speed === "standard" || speed === "fast" ? speed : undefined;
};

const usageOf = (usage: Schema.JsonObject): Usage => {
  const split = asObject(usage["cache_creation"]);
  const total = count(usage["cache_creation_input_tokens"]);
  return {
    inputTokens: count(usage["input_tokens"]),
    cacheReadTokens: count(usage["cache_read_input_tokens"]),
    cacheWriteTokens: split === undefined ? total : count(split["ephemeral_5m_input_tokens"]),
    cacheWrite1hTokens: count(split?.["ephemeral_1h_input_tokens"]),
    outputTokens: count(usage["output_tokens"]),
    reasoningTokens: count(asObject(usage["output_tokens_details"])?.["thinking_tokens"]),
  };
};

const requestsOf = (draft: RequestDraft): ReadonlyArray<NormalizedRequest> => {
  if (draft.synthetic || draft.usage === undefined) return [];
  const usage = draft.usage;
  const speed = speedOf(usage);
  const shared = {
    messageKey: draft.messageKey,
    requestedAt: draft.requestedAt,
    usageBasis: "reported",
    sourceRecordKey: draft.recordKey,
    ...(speed === undefined ? {} : { speed }),
  } as const;
  const withModel = (model: string | undefined) => {
    const modelRaw = model ?? "unknown";
    const routeHint = routeHintOf(modelRaw);
    return { modelRaw, ...(routeHint === undefined ? {} : { routeHint }) };
  };
  const iterations = asArray(usage["iterations"]);
  return [
    { requestKey: draft.messageKey, ...withModel(draft.model), ...shared, usage: usageOf(usage) },
    ...iterations.flatMap((value, index): ReadonlyArray<NormalizedRequest> => {
      const iteration = asObject(value);
      if (iteration === undefined) return [];
      const type = asString(iteration["type"]);
      const advisor = type === "advisor_message";
      if (!advisor && index === iterations.length - 1) return [];
      const model =
        asString(iteration["model"]) ??
        (advisor ? (draft.advisorModel ?? draft.model) : draft.model);
      return [
        {
          requestKey: `${draft.messageKey}#${index}`,
          ...withModel(model),
          ...shared,
          usage: usageOf(iteration),
        },
      ];
    }),
  ];
};

const base64Bytes = (data: string): number => Math.floor((data.replace(/=+$/, "").length * 3) / 4);

const blobBytes = (data: Schema.Json | undefined): number | undefined => {
  if (isOmittedBlob(data)) return data.bytes;
  const encoded = asString(data);
  return encoded === undefined ? undefined : base64Bytes(encoded);
};

const imagePartOf = (block: Schema.JsonObject): MessagePart => {
  const source = asObject(block["source"]);
  const mediaType = asString(source?.["media_type"]);
  const bytes = blobBytes(source?.["data"]);
  return {
    type: "image",
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(bytes === undefined ? {} : { bytes }),
    ...storedBlobOf(source?.["data"]),
  };
};

const textOfContent = (content: Json | undefined): string | null => {
  if (typeof content === "string") return content;
  if (!isArray(content)) return null;
  const texts = content.flatMap((value) => {
    const block = asObject(value);
    const text = block === undefined ? undefined : asString(block["text"]);
    return text === undefined ? [] : [text];
  });
  return texts.length === 0 ? null : texts.join("\n");
};

const titleOf = (text: string): string => {
  const line =
    text
      .split("\n")
      .find((candidate) => candidate.trim().length > 0)
      ?.trim() ?? "";
  return line.length > 120 ? line.slice(0, 120) : line;
};

const normalize = (
  conversationKey: string,
  records: ReadonlyArray<SourceRecordRow>,
): NormalizedConversation | null => {
  const messages: Array<MessageDraft> = [];
  const assistants = new Map<string, MessageDraft>();
  const tools = new Map<string, ToolDraft>();
  const groups = new Map<string, RequestDraft>();
  const messageOfUuid = new Map<string, string>();
  const messageOfToolCall = new Map<string, string>();
  const spawnOfPath = new Map<string, string>();
  const seen = new Set<string>();
  let projectPath: string | undefined;
  let gitBranch: string | undefined;
  let clientVersion: string | undefined;
  let aiTitle: string | undefined;
  let customTitle: string | undefined;

  for (const entry of orderedEntries(records)) {
    const { record } = entry;
    const uuid = asString(record["uuid"]);
    const fallbackKey = `${entry.path}:${entry.offset}`;
    const dedupeKey = `r:${uuid ?? fallbackKey}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    projectPath = asString(record["relocatedCwd"]) ?? asString(record["cwd"]) ?? projectPath;
    gitBranch = asString(record["gitBranch"]) ?? gitBranch;
    clientVersion = asString(record["version"]) ?? clientVersion;

    const type = asString(record["type"]);
    const createdAt = timestampOf(record["timestamp"], entry.observedAt);
    const parentUuid = asString(record["parentUuid"]);

    if (type === undefined) {
      const toolUseId = asString(record["toolUseId"]);
      if (toolUseId !== undefined && entry.path.endsWith(".meta.json")) {
        spawnOfPath.set(entry.path.replace(/\.meta\.json$/, ".jsonl"), toolUseId);
      }
      continue;
    }

    if (type === "ai-title") {
      aiTitle = asString(record["aiTitle"]) ?? aiTitle;
      continue;
    }
    if (type === "custom-title") {
      customTitle = asString(record["customTitle"]) ?? customTitle;
      continue;
    }

    if (type === "assistant") {
      const message = asObject(record["message"]);
      if (message === undefined) continue;
      const messageKey = asString(message["id"]) ?? fallbackKey;
      const blockIndex = record["apiBlockIndex"];
      const blockKey = `b:${messageKey}#${typeof blockIndex === "number" ? blockIndex : (uuid ?? fallbackKey)}`;
      if (seen.has(blockKey)) continue;
      seen.add(blockKey);
      if (uuid !== undefined) messageOfUuid.set(uuid, messageKey);

      let draft = assistants.get(messageKey);
      if (draft === undefined) {
        draft = {
          messageKey,
          role: "assistant",
          path: entry.path,
          createdAt,
          parentUuid,
          parentMessageKey: undefined,
          parts: [],
        };
        assistants.set(messageKey, draft);
        messages.push(draft);
      }

      const content = message["content"];
      const blocks =
        typeof content === "string"
          ? [{ type: "text", text: content } satisfies Schema.JsonObject]
          : asArray(content);
      for (const value of blocks) {
        const block = asObject(value);
        if (block === undefined) continue;
        const blockType = asString(block["type"]);
        if (blockType === "text") {
          draft.parts.push({ type: "text", text: asString(block["text"]) ?? "" });
        } else if (blockType === "thinking") {
          draft.parts.push({ type: "thinking", text: asString(block["thinking"]) ?? "" });
        } else if (blockType === "tool_use") {
          const toolKey = asString(block["id"]) ?? `${messageKey}:${draft.parts.length}`;
          const name = asString(block["name"]) ?? "unknown";
          const input = block["input"] ?? null;
          draft.parts.push({ type: "tool_call", toolKey, name, input });
          messageOfToolCall.set(toolKey, messageKey);
          if (!tools.has(toolKey)) {
            tools.set(toolKey, {
              messageKey,
              name,
              input,
              output: null,
              status: "unknown",
              startedAt: createdAt,
              endedAt: undefined,
            });
          }
        } else {
          draft.parts.push({ type: "opaque", kind: blockType ?? "unknown", data: block });
        }
      }

      const usage = asObject(message["usage"]);
      const model = asString(message["model"]);
      const synthetic = model === "<synthetic>" || record["isApiErrorMessage"] === true;
      const group = groups.get(messageKey);
      if (group === undefined) {
        groups.set(messageKey, {
          messageKey,
          requestedAt: createdAt,
          model,
          usage,
          recordKey: entry.recordKey,
          advisorModel: asString(record["advisorModel"]),
          synthetic,
        });
      } else if (usage !== undefined) {
        group.usage = usage;
        group.model = model ?? group.model;
        group.recordKey = entry.recordKey;
        group.synthetic = synthetic;
        group.advisorModel = asString(record["advisorModel"]) ?? group.advisorModel;
      }
      continue;
    }

    const parts: Array<MessagePart> = [];
    let role: Role = type === "user" ? "user" : "system";

    if (type === "user") {
      const content = asObject(record["message"])?.["content"];
      if (typeof content === "string") {
        parts.push({ type: "text", text: content });
      } else {
        for (const value of asArray(content)) {
          const block = asObject(value);
          if (block === undefined) continue;
          const blockType = asString(block["type"]);
          if (blockType === "text") {
            parts.push({ type: "text", text: asString(block["text"]) ?? "" });
          } else if (blockType === "image") {
            parts.push(imagePartOf(block));
          } else if (blockType === "tool_result") {
            role = "tool";
            const toolKey = asString(block["tool_use_id"]) ?? fallbackKey;
            const output = textOfContent(block["content"]);
            const isError = block["is_error"] === true;
            parts.push({ type: "tool_result", toolKey, output, ...(isError ? { isError } : {}) });
            for (const nested of asArray(block["content"])) {
              const nestedBlock = asObject(nested);
              if (nestedBlock !== undefined && asString(nestedBlock["type"]) === "image") {
                parts.push(imagePartOf(nestedBlock));
              }
            }
            const tool = tools.get(toolKey);
            if (tool !== undefined) {
              tool.output = output;
              tool.status = isError ? "error" : "ok";
              tool.endedAt = createdAt;
            }
          } else {
            parts.push({ type: "opaque", kind: blockType ?? "unknown", data: block });
          }
        }
      }
    } else if (type === "attachment") {
      const attachment = asObject(record["attachment"]);
      if (attachment === undefined) continue;
      parts.push({
        type: "opaque",
        kind: `attachment:${asString(attachment["type"]) ?? "unknown"}`,
        data: attachment,
      });
    } else if (type === "system") {
      const subtype = asString(record["subtype"]);
      const content = asString(record["content"]);
      if (content !== undefined) parts.push({ type: "text", text: content });
      else if (subtype === "compact_boundary" || subtype === "api_error") {
        parts.push({ type: "opaque", kind: `system:${subtype}`, data: record });
      }
    }

    if (parts.length === 0) continue;
    const draft: MessageDraft = {
      messageKey: uuid ?? fallbackKey,
      role,
      path: entry.path,
      createdAt,
      parentUuid,
      parentMessageKey: undefined,
      parts,
    };
    if (uuid !== undefined) messageOfUuid.set(uuid, draft.messageKey);
    messages.push(draft);
  }

  if (messages.length === 0) return null;

  for (const draft of messages) {
    const parent =
      draft.parentUuid === undefined
        ? messageOfToolCall.get(spawnOfPath.get(draft.path) ?? "")
        : messageOfUuid.get(draft.parentUuid);
    draft.parentMessageKey = parent === draft.messageKey ? undefined : parent;
  }

  const normalizedMessages: ReadonlyArray<NormalizedMessage> = messages.map((draft, seq) => ({
    messageKey: draft.messageKey,
    seq,
    role: draft.role,
    ...(draft.parentMessageKey === undefined ? {} : { parentMessageKey: draft.parentMessageKey }),
    createdAt: draft.createdAt,
    parts: draft.parts,
    text: textOfParts(draft.parts),
  }));

  const toolExecutions: ReadonlyArray<NormalizedToolExecution> = [...tools].map(([toolKey, tool]) =>
    toolExecutionOf(toolKey, tool),
  );

  let startedAt = messages[0]?.createdAt ?? "";
  let endedAt = startedAt;
  for (const message of messages) {
    if (Date.parse(message.createdAt) < Date.parse(startedAt)) startedAt = message.createdAt;
    if (Date.parse(message.createdAt) > Date.parse(endedAt)) endedAt = message.createdAt;
  }
  const firstUserText = normalizedMessages.find((message) => message.role === "user")?.text;
  const title =
    customTitle ?? aiTitle ?? (firstUserText === undefined ? undefined : titleOf(firstUserText));

  return {
    conversationKey,
    ...(title === undefined || title === "" ? {} : { title }),
    ...(projectPath === undefined ? {} : { projectPath }),
    ...(gitBranch === undefined ? {} : { gitBranch }),
    ...(clientVersion === undefined ? {} : { clientVersion }),
    startedAt,
    endedAt,
    messages: normalizedMessages,
    toolExecutions,
    requests: [...groups.values()].flatMap(requestsOf),
  };
};

export const claudeNormalizer: Normalizer = {
  id: "claude",
  parserVersion: 2,
  conversationKeyOf,
  normalize,
};

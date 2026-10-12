import {
  isJsonObject,
  jsonStringAt,
  type MessagePart,
  type NormalizedConversation,
  type NormalizedMessage,
  type NormalizedRequest,
  type TaskCategory,
} from "@aqt/turnstash-core";
import { Predicate, type Schema } from "effect";

import {
  classifyTurn,
  isAgentTool,
  isMcpTool,
  isShellTool,
  isSkillTool,
  type ToolStep,
} from "./classify.ts";
import { commandNames } from "./shell.ts";

export const analysisVersion = 5;

export interface TurnFacts {
  readonly index: number;
  readonly firstSeq: number;
  readonly startedAt: string;
  readonly userExcerpt: string;
  readonly category: TaskCategory;
  readonly skill: string | null;
  readonly tools: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  readonly mcpServers: ReadonlyArray<string>;
  readonly commands: ReadonlyArray<string>;
  readonly edits: number;
  readonly retries: number;
  readonly requestKeys: ReadonlyArray<string>;
}

export interface ConversationAnalysis {
  readonly turns: ReadonlyArray<TurnFacts>;
  readonly turnOfMessage: ReadonlyMap<string, number>;
  readonly turnOfRequest: ReadonlyMap<string, number>;
}

const patchFile = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m;

const commandField = (input: Schema.Json): string | undefined => {
  if (!isJsonObject(input)) return undefined;
  const value = input["command"] ?? input["cmd"];
  if (Predicate.isString(value)) return value === "" ? undefined : value;
  return Array.isArray(value) && value.every(Predicate.isString)
    ? value.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ")
    : undefined;
};

const stepOf = (part: Extract<MessagePart, { type: "tool_call" }>): ToolStep => ({
  tool: part.name,
  file: Predicate.isString(part.input)
    ? patchFile.exec(part.input)?.[1]?.trim()
    : jsonStringAt(part.input, "file_path", "path", "filePath", "notebook_path", "target_file"),
  command: commandField(part.input),
  skill: isSkillTool(part.name) ? jsonStringAt(part.input, "skill", "name") : undefined,
});

const excerptOf = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 160);

const startsTurn = (parts: ReadonlyArray<MessagePart>): boolean =>
  parts.some((part) => (part.type === "text" && part.text.trim() !== "") || part.type === "image");

interface Draft {
  readonly index: number;
  readonly firstSeq: number;
  readonly startedAt: string;
  userMessage: string;
  answered: boolean;
  readonly steps: Array<ToolStep>;
  readonly messageKeys: Set<string>;
}

const unique = (values: ReadonlyArray<string>): Array<string> => [...new Set(values)];

const spawnsAgent = (parts: ReadonlyArray<MessagePart>): boolean =>
  parts.some((part) => part.type === "tool_call" && isAgentTool(part.name));

const openDraft = (
  drafts: Array<Draft>,
  message: NormalizedMessage,
  userMessage: string,
): Draft => {
  const draft: Draft = {
    index: drafts.length,
    firstSeq: message.seq,
    startedAt: message.createdAt,
    userMessage,
    answered: false,
    steps: [],
    messageKeys: new Set(),
  };
  drafts.push(draft);
  return draft;
};

const assignRequests = (
  requests: ReadonlyArray<NormalizedRequest>,
  drafts: ReadonlyArray<Draft>,
  turnOfMessage: ReadonlyMap<string, number>,
) => {
  const turnOfRequest = new Map<string, number>();
  const requestKeys = drafts.map((): Array<string> => []);
  const draftStarts = drafts.map((draft) => ({
    index: draft.index,
    startedAt: Date.parse(draft.startedAt),
  }));
  const chronological = requests
    .map((request) => ({ request, at: Date.parse(request.requestedAt) }))
    .sort((a, b) => a.at - b.at);
  for (const { request, at } of chronological) {
    const byMessage =
      request.messageKey === undefined ? undefined : turnOfMessage.get(request.messageKey);
    const index =
      byMessage ??
      draftStarts.findLast((draft) => draft.startedAt <= at)?.index ??
      (drafts.length > 0 ? 0 : undefined);
    if (index === undefined) continue;
    turnOfRequest.set(request.requestKey, index);
    requestKeys[index]?.push(request.requestKey);
  }
  return { turnOfRequest, requestKeys };
};

const turnFactsOf = (
  draft: Draft,
  requestKeys: ReadonlyArray<ReadonlyArray<string>>,
): TurnFacts => {
  const skills = unique(
    draft.steps.flatMap((step) => (step.skill === undefined ? [] : [step.skill])),
  );
  const classification = classifyTurn({
    userMessage: draft.userMessage,
    steps: draft.steps,
    skills,
  });
  return {
    index: draft.index,
    firstSeq: draft.firstSeq,
    startedAt: draft.startedAt,
    userExcerpt: excerptOf(draft.userMessage),
    category: classification.category,
    skill: classification.skill,
    tools: unique(draft.steps.map((step) => step.tool)),
    skills,
    mcpServers: unique(
      draft.steps
        .filter((step) => isMcpTool(step.tool))
        .map((step) => step.tool.split("__")[1] ?? ""),
    ).filter((value) => value !== ""),
    commands: unique(
      draft.steps
        .filter((step) => isShellTool(step.tool) && step.command !== undefined)
        .flatMap((step) => commandNames(step.command ?? "")),
    ),
    edits: classification.edits,
    retries: classification.retries,
    requestKeys: requestKeys[draft.index] ?? [],
  };
};

// A user prompt whose parent is the assistant message that spawned a subagent is that subagent's first
// message: its whole thread belongs to the spawning turn, as do consecutive prompts before any answer.
export const analyzeConversation = (conversation: NormalizedConversation): ConversationAnalysis => {
  const messages = [...conversation.messages].sort((a, b) => a.seq - b.seq);
  const drafts: Array<Draft> = [];
  const turnOfMessage = new Map<string, number>();
  const spawning = new Set<string>();
  for (const message of messages) {
    const parentTurn =
      message.parentMessageKey === undefined
        ? undefined
        : turnOfMessage.get(message.parentMessageKey);
    const delegated =
      message.parentMessageKey !== undefined && spawning.has(message.parentMessageKey);
    const isPrompt = message.role === "user" && startsTurn(message.parts);
    let draft: Draft | undefined;
    if (isPrompt && !delegated) {
      const current = drafts.at(-1);
      if (current !== undefined && !current.answered) {
        current.userMessage = message.text;
        draft = current;
      } else {
        draft = openDraft(drafts, message, message.text);
      }
    } else {
      draft = (parentTurn === undefined ? undefined : drafts[parentTurn]) ?? drafts.at(-1);
      if (draft === undefined) draft = openDraft(drafts, message, "");
    }
    draft.messageKeys.add(message.messageKey);
    turnOfMessage.set(message.messageKey, draft.index);
    if (message.role === "assistant") {
      draft.answered = true;
      if (spawnsAgent(message.parts)) spawning.add(message.messageKey);
      for (const part of message.parts)
        if (part.type === "tool_call") draft.steps.push(stepOf(part));
    }
  }

  const { turnOfRequest, requestKeys } = assignRequests(
    conversation.requests,
    drafts,
    turnOfMessage,
  );
  const turns = drafts.map((draft) => turnFactsOf(draft, requestKeys));
  return { turns, turnOfMessage, turnOfRequest };
};

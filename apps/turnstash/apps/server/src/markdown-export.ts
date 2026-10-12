import { BadRequest, type MarkdownExportInput, NotFound } from "@aqt/turnstash-api";
import { MessagePart, Role } from "@aqt/turnstash-core";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { lockConversations } from "./conversation-locks.ts";
import { Db, inTransaction } from "./db/client.ts";
import { conversations, messages, toolExecutions } from "./db/schema.ts";

const ExportMessage = Schema.Struct({
  messageKey: Schema.String,
  seq: Schema.Int,
  role: Role,
  parts: Schema.Array(MessagePart),
});
type ExportMessage = typeof ExportMessage.Type;

const escapeLabel = (value: string) =>
  value.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}[\]<>#!|]/g, "\\$&");
const fence = (value: string, language = "") => {
  const runs = value.match(/`+/g) ?? [];
  const delimiter = "`".repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), 3));
  return `${delimiter}${language}\n${value}\n${delimiter}`;
};

export const messageMarkdown = (message: ExportMessage, includeTools: boolean): string => {
  if (message.role === "system" || (message.role === "tool" && !includeTools)) return "";
  return message.parts
    .flatMap((part) => {
      switch (part.type) {
        case "text":
          return [message.role === "tool" ? fence(part.text) : part.text];
        case "tool_call":
          return includeTools
            ? [
                `Tool: ${escapeLabel(part.name)}\n\n${fence(JSON.stringify(part.input, null, 2), "json")}`,
              ]
            : [];
        case "tool_result":
          return includeTools && part.output !== null ? [fence(part.output)] : [];
        case "image":
          return ["[Archived image]"];
        case "thinking":
        case "opaque":
          return [];
      }
    })
    .filter((part) => part.trim() !== "")
    .join("\n\n");
};

export const exportMarkdown = Effect.fn("Export.markdown")(function* (
  id: string,
  input: MarkdownExportInput,
) {
  const db = yield* Db;
  const [identity] = yield* db.select().from(conversations).where(eq(conversations.id, id));
  if (identity === undefined) return yield* new NotFound({ entity: "conversation", id });
  yield* lockConversations([identity]);
  const [conversation] = yield* db.select().from(conversations).where(eq(conversations.id, id));
  if (conversation === undefined) return yield* new NotFound({ entity: "conversation", id });
  const selection = input.selection;
  const requested = selection.kind === "conversation" ? [] : [...new Set(selection.messageKeys)];
  const anchors =
    requested.length === 0
      ? []
      : yield* db
          .select({ messageKey: messages.messageKey, turnIndex: messages.turnIndex })
          .from(messages)
          .where(and(eq(messages.conversationId, id), inArray(messages.messageKey, requested)));
  if (anchors.length !== requested.length)
    return yield* new BadRequest({
      message: "One or more selected messages are no longer archived.",
    });
  if (selection.kind === "turns" && anchors.some((anchor) => anchor.turnIndex === null))
    return yield* new BadRequest({
      message: "One or more selected turn anchors are no longer available.",
    });
  const turnIndexes = [
    ...new Set(anchors.flatMap((anchor) => (anchor.turnIndex === null ? [] : [anchor.turnIndex]))),
  ];
  const selected = yield* db
    .select({
      messageKey: messages.messageKey,
      seq: messages.seq,
      role: messages.role,
      parts: messages.parts,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, id),
        selection.kind === "messages" ? inArray(messages.messageKey, requested) : undefined,
        selection.kind === "turns" ? inArray(messages.turnIndex, turnIndexes) : undefined,
      ),
    )
    .orderBy(asc(messages.seq));
  const parsed = yield* Schema.decodeUnknownEffect(Schema.Array(ExportMessage))(selected).pipe(
    Effect.orDie,
  );
  const includeTools = input.includeTools ?? false;
  const conversationLink = `${input.sourceOrigin ?? ""}/conversations/${id}`;
  const sourceLink = (messageKey: string) =>
    `${conversationLink}?message=${encodeURIComponent(messageKey).replaceAll("(", "%28").replaceAll(")", "%29")}`;
  const sections = parsed.flatMap((message) => {
    const content = messageMarkdown(message, includeTools);
    if (content === "") return [];
    return [`## ${message.role}\n\n[Source](${sourceLink(message.messageKey)})\n\n${content}`];
  });
  if (includeTools) {
    const keys = selected.map((row) => row.messageKey);
    const tools =
      keys.length === 0
        ? []
        : yield* db
            .select()
            .from(toolExecutions)
            .where(
              and(eq(toolExecutions.conversationId, id), inArray(toolExecutions.messageKey, keys)),
            )
            .orderBy(asc(toolExecutions.startedAt), asc(toolExecutions.toolKey));
    const embedded = new Set(
      parsed.flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "tool_result" && part.output !== null ? [part.toolKey] : [],
        ),
      ),
    );
    for (const tool of tools) {
      if (tool.output === null || embedded.has(tool.toolKey)) continue;
      sections.push(
        `## Tool output: ${escapeLabel(tool.name)}\n\n[Source](${sourceLink(tool.messageKey ?? "")})\n\n${fence(tool.output)}`,
      );
    }
  }
  return {
    filename: `turnstash-${id}.md`,
    markdown: `# ${escapeLabel(conversation.title ?? conversation.conversationKey)}\n\n[Conversation](${conversationLink})\n\n${sections.join("\n\n")}\n`,
  };
}, inTransaction);

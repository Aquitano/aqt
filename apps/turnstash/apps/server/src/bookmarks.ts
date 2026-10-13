import { BadRequest, type BookmarkInput, BookmarkView, NotFound } from "@aqt/turnstash-api";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { lockConversations } from "./conversation-locks.ts";
import { Db, inTransaction } from "./db/client.ts";
import { bookmarks, conversations, conversationTurns, messages } from "./db/schema.ts";
import { scrubText } from "./scrub.ts";

const bookmarkRows = (db: Db["Service"]) =>
  db
    .select({
      bookmark: bookmarks,
      conversationTitle: conversations.title,
      parts: messages.parts,
      messageKey: messages.messageKey,
      hasTurn: sql<boolean>`exists(select 1 from ${conversationTurns} where ${conversationTurns.conversationId} = ${bookmarks.conversationId} and ${conversationTurns.turnIndex} = ${messages.turnIndex})`,
      turnExcerpt: sql<
        string | null
      >`(select ${conversationTurns.userExcerpt} from ${conversationTurns} where ${conversationTurns.conversationId} = ${bookmarks.conversationId} and ${conversationTurns.turnIndex} = ${messages.turnIndex})`,
    })
    .from(bookmarks)
    .innerJoin(conversations, eq(conversations.id, bookmarks.conversationId))
    .leftJoin(
      messages,
      and(
        eq(messages.conversationId, bookmarks.conversationId),
        eq(messages.messageKey, bookmarks.messageKey),
      ),
    );

const view = (row: Effect.Success<ReturnType<typeof bookmarkRows>>[number]) =>
  Schema.decodeUnknownEffect(BookmarkView)({
    id: row.bookmark.id,
    conversationId: row.bookmark.conversationId,
    conversationTitle: row.conversationTitle,
    target:
      row.bookmark.kind === "conversation"
        ? { kind: "conversation" }
        : { kind: row.bookmark.kind, messageKey: row.bookmark.messageKey },
    note: row.bookmark.note,
    excerpt:
      row.bookmark.kind === "turn"
        ? (row.turnExcerpt ?? "")
        : (row.parts ?? [])
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
            .slice(0, 240),
    available:
      row.bookmark.kind === "conversation" ||
      (row.messageKey !== null && (row.bookmark.kind !== "turn" || row.hasTurn)),
    createdAt: row.bookmark.createdAt.toISOString(),
    updatedAt: row.bookmark.updatedAt.toISOString(),
  }).pipe(Effect.orDie);

const getBookmark = Effect.fn("Bookmarks.get")(function* (id: string) {
  const db = yield* Db;
  const [row] = yield* bookmarkRows(db).where(eq(bookmarks.id, id));
  if (row === undefined) return yield* new NotFound({ entity: "bookmark", id });
  return yield* view(row);
});

export const listBookmarks = Effect.fn("Bookmarks.list")(function* (query: {
  readonly conversationId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}) {
  const db = yield* Db;
  const [cursor] =
    query.cursor === undefined
      ? []
      : yield* db.select().from(bookmarks).where(eq(bookmarks.id, query.cursor));
  if (query.cursor !== undefined && cursor === undefined)
    return yield* new NotFound({ entity: "bookmark cursor", id: query.cursor });
  const limit = query.limit ?? 50;
  const rows = yield* bookmarkRows(db)
    .where(
      and(
        query.conversationId === undefined
          ? undefined
          : eq(bookmarks.conversationId, query.conversationId),
        cursor === undefined
          ? undefined
          : or(
              lt(bookmarks.createdAt, cursor.createdAt),
              and(eq(bookmarks.createdAt, cursor.createdAt), lt(bookmarks.id, cursor.id)),
            ),
      ),
    )
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: yield* Effect.forEach(page, view),
    nextCursor: rows.length > limit ? (page.at(-1)?.bookmark.id ?? null) : null,
  };
});

export const createBookmark = Effect.fn("Bookmarks.create")(function* (input: BookmarkInput) {
  const db = yield* Db;
  const [conversation] = yield* db
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.conversationId));
  if (conversation === undefined)
    return yield* new NotFound({ entity: "conversation", id: input.conversationId });
  yield* lockConversations([conversation]);
  const current = yield* db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId));
  if (current.length === 0)
    return yield* new NotFound({ entity: "conversation", id: input.conversationId });
  const messageKey = input.target.kind === "conversation" ? "" : input.target.messageKey;
  if (input.target.kind !== "conversation") {
    const [message] = yield* db
      .select()
      .from(messages)
      .where(
        and(eq(messages.conversationId, input.conversationId), eq(messages.messageKey, messageKey)),
      );
    if (message === undefined) return yield* new NotFound({ entity: "message", id: messageKey });
    if (input.target.kind === "turn") {
      const [turn] = yield* db
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.conversationId, input.conversationId),
            eq(conversationTurns.firstSeq, message.seq),
          ),
        );
      if (turn === undefined)
        return yield* new BadRequest({ message: "The turn anchor must be its first message." });
    }
  }
  const [row] = yield* db
    .insert(bookmarks)
    .values({
      conversationId: input.conversationId,
      kind: input.target.kind,
      messageKey,
      note: scrubText(input.note ?? ""),
    })
    .onConflictDoUpdate({
      target: [bookmarks.conversationId, bookmarks.kind, bookmarks.messageKey],
      set: { id: sql`${bookmarks.id}` },
    })
    .returning({ id: bookmarks.id });
  if (row === undefined) return yield* Effect.die("Bookmark insert returned no row");
  return yield* getBookmark(row.id);
}, inTransaction);

export const updateBookmark = Effect.fn("Bookmarks.update")(function* (id: string, note: string) {
  const db = yield* Db;
  const [row] = yield* db
    .update(bookmarks)
    .set({ note: scrubText(note), updatedAt: sql`now()` })
    .where(eq(bookmarks.id, id))
    .returning({ id: bookmarks.id });
  if (row === undefined) return yield* new NotFound({ entity: "bookmark", id });
  return yield* getBookmark(id);
});

export const deleteBookmark = Effect.fn("Bookmarks.delete")(function* (id: string) {
  const db = yield* Db;
  const rows = yield* db
    .delete(bookmarks)
    .where(eq(bookmarks.id, id))
    .returning({ id: bookmarks.id });
  if (rows.length === 0) return yield* new NotFound({ entity: "bookmark", id });
});

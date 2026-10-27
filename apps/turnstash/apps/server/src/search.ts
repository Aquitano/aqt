import type { SearchHit, SearchQuery, SearchResult } from "@aqt/turnstash-api";
import type { ProviderId, Role } from "@aqt/turnstash-core";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { Effect } from "effect";

import { Db } from "./db/client.ts";
import { conversations, messages } from "./db/schema.ts";
import { dateWindow, number, projectCondition } from "./filters.ts";

interface SearchRow extends Record<string, unknown> {
  readonly conversation_id: string;
  readonly message_id: string;
  readonly message_key: string;
  readonly seq: number;
  readonly role: Role;
  readonly provider: ProviderId;
  readonly title: string | null;
  readonly project_key: string | null;
  readonly created_at: Date;
  readonly score: number | string;
}

interface SnippetRow extends Record<string, unknown> {
  readonly id: string;
  readonly snippet: string;
}

export const search = Effect.fn("Search.run")(function* (query: SearchQuery) {
  const db = yield* Db;
  const limit = query.limit ?? 50;
  const window = dateWindow(query);
  const filters =
    and(
      query.provider === undefined ? undefined : eq(conversations.provider, query.provider),
      query.projectKey === undefined ? undefined : projectCondition(query.projectKey),
      query.role === undefined ? undefined : eq(messages.role, query.role),
      window.from === null ? undefined : gte(messages.createdAt, window.from),
      window.to === null ? undefined : lt(messages.createdAt, window.to),
    ) ?? sql`true`;
  const matches = sql`paradedb.parse_with_field('text', ${query.q}, lenient => true)`;
  const rows = yield* db.execute<SearchRow>(
    sql`
    select messages.conversation_id, messages.id as message_id, messages.message_key, messages.seq, messages.role,
           conversations.provider, conversations.title, conversations.project_key, messages.created_at,
           paradedb.score(messages.id) as score
    from messages join conversations on conversations.id = messages.conversation_id
    where messages.id @@@ ${matches} and ${filters}
    order by score desc limit ${limit}`,
    "objects",
  );
  // The BM25 scan builds a snippet for every match it returns, before the join and the limit, so snippets are
  // fetched in a second scan restricted to the ranked ids. A bound uuid array is pushed into the index as a
  // term set; a subquery would not be.
  const snippets =
    rows.length === 0
      ? []
      : yield* db.execute<SnippetRow>(
          sql`
          select id, paradedb.snippet(text, max_num_chars => 300) as snippet
          from messages
          where id @@@ ${matches} and id = any(${`{${rows.map((row) => row.message_id).join(",")}}`}::uuid[])`,
          "objects",
        );
  const snippetOf = new Map(snippets.map((row) => [row.id, row.snippet]));
  return {
    hits: rows.map((row): SearchHit => ({
      conversationId: row.conversation_id,
      messageId: row.message_id,
      messageKey: row.message_key,
      seq: row.seq,
      role: row.role,
      provider: row.provider,
      title: row.title,
      projectKey: row.project_key,
      createdAt: new Date(row.created_at).toISOString(),
      snippet: snippetOf.get(row.message_id) ?? "",
      score: number(row.score),
    })),
  } satisfies SearchResult;
});

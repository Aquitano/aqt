import type { SearchHit, SearchQuery, SearchResult } from "@aqt/turnstash-api";
import type { ProviderId, Role } from "@aqt/turnstash-core";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { Effect } from "effect";

import { Db } from "./db/client.ts";
import { conversations, messages } from "./db/schema.ts";
import { dateWindow, number, projectCondition } from "./filters.ts";

const hasBm25 = Effect.fn("Search.hasBm25")(function* () {
  const db = yield* Db;
  const rows = yield* db.execute<{ present: boolean }>(
    sql`select exists(select 1 from pg_indexes where indexname = 'messages_bm25') as present`,
    "objects",
  );
  return rows[0]?.present === true;
});

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
  readonly snippet: string;
  readonly score: number | string;
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
  // BM25 ranks the whole match set cheaply; snippets are built only for the rows that survive the limit.
  const rows = (yield* hasBm25())
    ? yield* db.execute<SearchRow>(
        sql`
        with top as (
          select messages.id, paradedb.score(messages.id) as score
          from messages join conversations on conversations.id = messages.conversation_id
          where messages.id @@@ paradedb.parse_with_field('text', ${query.q}, lenient => true) and ${filters}
          order by score desc limit ${limit}
        )
        select m.conversation_id, m.id as message_id, m.message_key, m.seq, m.role, c.provider, c.title, c.project_key, m.created_at,
               ts_headline('english', m.text, websearch_to_tsquery('english', ${query.q}), 'MaxFragments=2, MaxWords=24, MinWords=8') as snippet,
               top.score
        from top join messages m on m.id = top.id join conversations c on c.id = m.conversation_id
        order by top.score desc`,
        "objects",
      )
    : yield* db.execute<SearchRow>(
        sql`
        select messages.conversation_id, messages.id as message_id, messages.message_key, messages.seq, messages.role,
               conversations.provider, conversations.title, conversations.project_key, messages.created_at,
               ts_headline('english', messages.text, websearch_to_tsquery('english', ${query.q}), 'MaxFragments=2, MaxWords=24, MinWords=8') as snippet,
               ts_rank(to_tsvector('english', messages.text), websearch_to_tsquery('english', ${query.q})) as score
        from messages join conversations on conversations.id = messages.conversation_id
        where to_tsvector('english', messages.text) @@ websearch_to_tsquery('english', ${query.q}) and ${filters}
        order by score desc limit ${limit}`,
        "objects",
      );
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
      snippet: row.snippet,
      score: number(row.score),
    })),
  } satisfies SearchResult;
});

import type { SearchHit, SearchQuery, SearchResult } from "@aqt/turnstash-api";
import type { ProviderId, Role } from "@aqt/turnstash-core";
import { and, eq, gte, lt, type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";

import { Db } from "./db/client.ts";
import { conversations, messages } from "./db/schema.ts";
import { dateWindow, number, projectCondition } from "./filters.ts";

interface SearchRow extends Record<string, unknown> {
  readonly hit_id: string;
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

// Message text and tool output each have a BM25 index. A match in tool output is reported on the message
// that made the call, where the transcript shows the output.
const indexes = {
  messages: { table: sql`messages`, field: "text", role: sql`messages.role`, join: sql`` },
  toolOutput: {
    table: sql`tool_executions`,
    field: "output",
    role: sql`'tool'::message_role`,
    join: sql`join messages on messages.conversation_id = tool_executions.conversation_id
              and messages.message_key = tool_executions.message_key`,
  },
} as const;

const searchIndex = Effect.fn("Search.index")(function* (
  index: (typeof indexes)[keyof typeof indexes],
  q: string,
  filters: SQL,
  limit: number,
) {
  const db = yield* Db;
  const matches = sql`paradedb.parse_with_field(${index.field}, ${q}, lenient => true)`;
  const rows = yield* db.execute<SearchRow>(
    sql`
    select ${index.table}.id as hit_id, messages.conversation_id, messages.id as message_id, messages.message_key,
           messages.seq, ${index.role} as role, conversations.provider, conversations.title,
           conversations.project_key, messages.created_at, paradedb.score(${index.table}.id) as score
    from ${index.table} ${index.join} join conversations on conversations.id = messages.conversation_id
    where ${index.table}.id @@@ ${matches} and ${filters}
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
          select id, paradedb.snippet(${sql.identifier(index.field)}, max_num_chars => 300) as snippet
          from ${index.table}
          where id @@@ ${matches} and id = any(${`{${rows.map((row) => row.hit_id).join(",")}}`}::uuid[])`,
          "objects",
        );
  const snippetOf = new Map(snippets.map((row) => [row.id, row.snippet]));
  return rows.map((row): SearchHit => ({
    conversationId: row.conversation_id,
    messageId: row.message_id,
    messageKey: row.message_key,
    seq: row.seq,
    role: row.role,
    provider: row.provider,
    title: row.title,
    projectKey: row.project_key,
    createdAt: new Date(row.created_at).toISOString(),
    snippet: snippetOf.get(row.hit_id) ?? "",
    score: number(row.score),
  }));
});

export const search = Effect.fn("Search.run")(function* (query: SearchQuery) {
  const limit = query.limit ?? 50;
  const window = dateWindow(query);
  const shared = and(
    query.provider === undefined ? undefined : eq(conversations.provider, query.provider),
    query.projectKey === undefined ? undefined : projectCondition(query.projectKey),
    window.from === null ? undefined : gte(messages.createdAt, window.from),
    window.to === null ? undefined : lt(messages.createdAt, window.to),
  );
  const ofRole = query.role === undefined ? undefined : eq(messages.role, query.role);
  const inMessages = yield* searchIndex(
    indexes.messages,
    query.q,
    and(shared, ofRole) ?? sql`true`,
    limit,
  );
  const inToolOutput =
    query.role === undefined || query.role === "tool"
      ? yield* searchIndex(indexes.toolOutput, query.q, shared ?? sql`true`, limit)
      : [];
  const best = new Map<string, SearchHit>();
  for (const hit of [...inMessages, ...inToolOutput].toSorted((a, b) => b.score - a.score))
    if (!best.has(hit.messageId)) best.set(hit.messageId, hit);
  return { hits: [...best.values()].slice(0, limit) } satisfies SearchResult;
});

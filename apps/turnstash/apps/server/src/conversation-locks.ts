import { sql } from "drizzle-orm";
import { Effect } from "effect";

import { Db } from "./db/client.ts";

export const lockConversations = Effect.fn("Conversations.lock")(function* (
  keys: ReadonlyArray<{ readonly provider: string; readonly conversationKey: string }>,
) {
  if (keys.length === 0) return;
  const db = yield* Db;
  const identities = keys.map(({ provider, conversationKey }) =>
    JSON.stringify([provider, conversationKey]),
  );
  yield* db.execute(sql`
    SELECT pg_advisory_xact_lock(lock_key)
    FROM (
      SELECT DISTINCT hashtextextended(value, 0) AS lock_key
      FROM unnest(ARRAY[${sql.join(
        identities.map((identity) => sql`${identity}`),
        sql`, `,
      )}]::text[]) AS value
      ORDER BY lock_key
    ) AS locks`);
});

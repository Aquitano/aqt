import { sql } from "drizzle-orm";
import { Effect } from "effect";

import type { Database } from "./client.ts";

export const readerRole = "turnstash_reader";

// The views are the read-only SQL interface, so their names and columns stay stable while the tables beneath
// them change. They are dropped before migrations run, because Postgres refuses to alter a column a view
// uses, and recreated after.
const views = [
  `CREATE VIEW analytics.sessions AS
   SELECT c.id, c.provider, c.parent_id, c.title, c.project_key, c.project_path, c.git_branch, c.client_version,
          c.started_at, c.ended_at, extract(epoch FROM c.ended_at - c.started_at)::float8 AS duration_seconds,
          c.message_count, c.request_count,
          array(SELECT m.name FROM conversation_machines cm JOIN machines m ON m.id = cm.machine_id
                WHERE cm.conversation_id = c.id ORDER BY m.name) AS machines
   FROM conversations c`,
  `CREATE VIEW analytics.requests AS
   SELECT r.id, r.conversation_id AS session_id, r.turn_index, r.provider, c.project_key, r.model_id, r.model_raw,
          r.route, r.speed, r.requested_at, r.input_tokens, r.cache_read_tokens, r.cache_write_tokens,
          r.cache_write_1h_tokens, r.output_tokens, r.reasoning_tokens, r.usage_basis,
          v.cost_usd, v.price_key, v.unpriced_reason, v.catalog_version
   FROM model_requests r
   JOIN conversations c ON c.id = r.conversation_id
   LEFT JOIN valuations v ON v.request_id = r.id AND v.active`,
  `CREATE VIEW analytics.turns AS
   SELECT conversation_id AS session_id, turn_index, started_at, user_excerpt, category, skill, primary_model_id,
          tools, skills, mcp_servers, commands, edits, retries
   FROM conversation_turns`,
  `CREATE VIEW analytics.messages AS
   SELECT id, conversation_id AS session_id, message_key, seq, turn_index, role, created_at, text
   FROM messages`,
  `CREATE VIEW analytics.tools AS
   SELECT id, conversation_id AS session_id, message_key, name, status, started_at, ended_at,
          (extract(epoch FROM ended_at - started_at) * 1000)::float8 AS duration_ms, input, output
   FROM tool_executions`,
  `CREATE VIEW analytics.machines AS
   SELECT id, name, os, arch, agent_version, enrolled_at, last_seen_at FROM machines`,
  `CREATE VIEW analytics.plans AS
   SELECT id, provider, name, monthly_price, currency, started_on, ended_on FROM subscription_plans`,
  `CREATE VIEW analytics.commits AS
   SELECT c.repo, c.sha, c.subject, c.ref, c.on_default_branch, c.authored_at, c.committed_at,
          l.conversation_id AS session_id
   FROM commits c LEFT JOIN commit_links l ON l.repo = c.repo AND l.sha = c.sha`,
  `CREATE VIEW analytics.bookmarks AS
   SELECT id, conversation_id AS session_id, kind, message_key, note, created_at FROM bookmarks`,
  `CREATE VIEW analytics.limit_samples AS
   SELECT id, provider, conversation_id AS session_id, plan, window_minutes, observed_at, used_percent, resets_at
   FROM limit_samples`,
  `CREATE VIEW analytics.limit_hits AS
   SELECT id, provider, conversation_id AS session_id, window_minutes, occurred_at, message FROM limit_hits`,
];

export const grantReader = [
  `GRANT USAGE ON SCHEMA analytics TO ${readerRole}`,
  `GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO ${readerRole}`,
];

export const dropAnalytics = (db: Database) =>
  db.execute(sql`DROP SCHEMA IF EXISTS analytics CASCADE`);

export const createAnalytics = Effect.fn("Db.createAnalytics")(function* (db: Database) {
  yield* db.execute(sql`CREATE SCHEMA analytics`);
  for (const view of views) yield* db.execute(sql.raw(view));
  const [role] = yield* db.execute<{ exists: boolean }>(
    sql`SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = ${readerRole}) AS exists`,
    "objects",
  );
  if (role?.exists === true) for (const grant of grantReader) yield* db.execute(sql.raw(grant));
});

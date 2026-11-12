import { sql } from "drizzle-orm";
import { Effect } from "effect";

import type { Database } from "./client.ts";

export const readerRole = "turnstash_reader";

// The views are the read-only SQL interface, so their names and columns stay stable while the tables beneath
// them change. They are dropped before migrations run, because Postgres refuses to alter a column a view
// uses, and recreated after. Only these views are dropped, without CASCADE, so an object someone built on one
// stops the migration instead of silently disappearing.
const views: Record<string, string> = {
  sessions: `SELECT c.id, c.provider, c.parent_id, c.title, c.project_key, c.project_path, c.git_branch, c.client_version,
          c.started_at, c.ended_at, extract(epoch FROM c.ended_at - c.started_at)::float8 AS duration_seconds,
          c.message_count, c.request_count,
          array(SELECT m.name FROM conversation_machines cm JOIN machines m ON m.id = cm.machine_id
                WHERE cm.conversation_id = c.id ORDER BY m.name) AS machines
   FROM conversations c`,
  requests: `SELECT r.id, r.conversation_id AS session_id, r.turn_index, r.provider, c.project_key, r.model_id, r.model_raw,
          r.route, r.speed, r.requested_at, r.input_tokens, r.cache_read_tokens, r.cache_write_tokens,
          r.cache_write_1h_tokens, r.output_tokens, r.reasoning_tokens, r.usage_basis,
          v.cost_usd, v.price_key, v.unpriced_reason, v.catalog_version
   FROM model_requests r
   JOIN conversations c ON c.id = r.conversation_id
   LEFT JOIN valuations v ON v.request_id = r.id AND v.active`,
  turns: `SELECT conversation_id AS session_id, turn_index, started_at, user_excerpt, category, skill, primary_model_id,
          tools, skills, mcp_servers, commands, edits, retries
   FROM conversation_turns`,
  messages: `SELECT id, conversation_id AS session_id, message_key, seq, turn_index, role, created_at, text
   FROM messages`,
  tools: `SELECT id, conversation_id AS session_id, message_key, name, status, started_at, ended_at,
          (extract(epoch FROM ended_at - started_at) * 1000)::float8 AS duration_ms, input, output
   FROM tool_executions`,
  machines: `SELECT id, name, os, arch, agent_version, enrolled_at, last_seen_at FROM machines`,
  plans: `SELECT id, provider, name, monthly_price, currency, started_on, ended_on FROM subscription_plans`,
  commits: `SELECT c.repo, c.sha, c.subject, c.ref, c.on_default_branch, c.authored_at, c.committed_at,
          l.conversation_id AS session_id
   FROM commits c LEFT JOIN commit_links l ON l.repo = c.repo AND l.sha = c.sha`,
  bookmarks: `SELECT id, conversation_id AS session_id, kind, message_key, note, created_at FROM bookmarks`,
  limit_samples: `SELECT id, provider, conversation_id AS session_id, plan, window_minutes, observed_at, used_percent, resets_at
   FROM limit_samples`,
  limit_hits: `SELECT id, provider, conversation_id AS session_id, window_minutes, occurred_at, message FROM limit_hits`,
  t3_threads: `SELECT t.id, m.name AS machine, t.title, t.project, t.project_root, t.provider, t.created_by,
          t.creation_source, t.parent_thread_id, t.relationship, t.model, t.effort, t.fast, t.branch,
          t.worktree_path, t.pull_requests, t.created_at, t.updated_at, t.archived_at, t.deleted_at
   FROM t3_threads t JOIN machines m ON m.id = t.machine_id`,
  // A Claude Code session id or Codex rollout id is the conversation key, so a run joins its archived session.
  // Codex keys are stored in lowercase, while Claude keys keep the transcript's spelling.
  t3_runs: `SELECT r.id, r.thread_id, m.name AS machine, r.ordinal, r.provider, r.status, r.model, r.effort, r.fast,
          r.requested_at, r.started_at, r.completed_at,
          extract(epoch FROM r.started_at - r.requested_at)::float8 AS queued_seconds,
          extract(epoch FROM r.completed_at - r.started_at)::float8 AS duration_seconds,
          r.attempts, r.native_session_id,
          (SELECT c.id FROM conversations c
           WHERE (c.provider = 'claude' AND c.conversation_key = r.native_session_id)
              OR (c.provider = 'codex' AND c.conversation_key = lower(r.native_session_id))
           LIMIT 1) AS session_id
   FROM t3_runs r JOIN machines m ON m.id = r.machine_id`,
};

export const grantReader = [
  `GRANT USAGE ON SCHEMA analytics TO ${readerRole}`,
  `GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO ${readerRole}`,
];

export const dropAnalytics = Effect.fn("Db.dropAnalytics")(function* (db: Database) {
  for (const name of Object.keys(views))
    yield* db.execute(sql.raw(`DROP VIEW IF EXISTS analytics.${name}`));
});

export const createAnalytics = Effect.fn("Db.createAnalytics")(function* (db: Database) {
  yield* db.execute(sql`CREATE SCHEMA IF NOT EXISTS analytics`);
  for (const [name, select] of Object.entries(views))
    yield* db.execute(sql.raw(`CREATE VIEW analytics.${name} AS ${select}`));
  const [role] = yield* db.execute<{ exists: boolean }>(
    sql`SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = ${readerRole}) AS exists`,
    "objects",
  );
  if (role?.exists === true) for (const grant of grantReader) yield* db.execute(sql.raw(grant));
});

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { type ProviderId, providerIds } from "@aqt/turnstash-core";
import { Effect } from "effect";

import { readT3 } from "../src/t3.ts";

// The columns T3 Code's statev2.sqlite has, cut down to the ones the agent reads.
const t3Schema = `
  CREATE TABLE projection_projects (project_id TEXT, title TEXT, workspace_root TEXT);
  CREATE TABLE projection_thread_pull_requests (thread_id TEXT, url TEXT);
  CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, title TEXT,
    default_provider TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT);
  CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, thread_id TEXT, ordinal INTEGER, provider TEXT,
    status TEXT, requested_at TEXT, completed_at TEXT, payload_json TEXT);
  CREATE TABLE orchestration_v2_projection_run_attempts (run_id TEXT, attempt_ordinal INTEGER, payload_json TEXT);
`;

const fixture = () => {
  const db = new Database(":memory:");
  db.run(t3Schema);
  db.query("INSERT INTO projection_projects VALUES ('p1', 'aqt', '/home/me/aqt')").run();
  db.query(
    "INSERT INTO projection_thread_pull_requests VALUES ('child', 'https://github.com/o/r/pull/1')",
  ).run();
  const thread = db.query(
    "INSERT INTO orchestration_v2_projection_threads VALUES (?, 'p1', ?, ?, ?, ?, NULL, NULL, ?)",
  );
  thread.run(
    "child",
    "Fix sk-ant-api03-" + "a".repeat(95),
    "codex",
    "2026-11-01T10:00:00.000Z",
    "2026-11-01T11:00:00.000Z",
    JSON.stringify({
      createdBy: "agent",
      creationSource: "mcp",
      lineage: { parentThreadId: "parent", relationshipToParent: "delegate" },
      modelSelection: {
        model: "gpt-6.1-sol",
        options: [
          { id: "reasoningEffort", value: "xhigh" },
          { id: "serviceTier", value: "priority" },
        ],
      },
      branch: "main",
      worktreePath: null,
    }),
  );
  thread.run(
    "old",
    "Older",
    "claudeAgent",
    "2026-10-01T10:00:00.000Z",
    "2026-10-01T10:00:00.000Z",
    "{}",
  );
  thread.run("broken", "No dates", "claudeAgent", "yesterday", "today", "{}");
  thread.run(
    "nul",
    "Bad\u0000title",
    "claudeAgent",
    "2026-11-01T10:00:00.000Z",
    "2026-11-01T10:00:00.000Z",
    "{}",
  );
  const run = db.query(
    "INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, 'claudeAgent', ?, ?, ?, ?)",
  );
  const claude = JSON.stringify({
    startedAt: "2026-11-01T10:00:02.000Z",
    modelSelection: {
      model: "claude-opus-5-5",
      options: [
        { id: "effort", value: "high" },
        { id: "fastMode", value: true },
      ],
    },
  });
  run.run(
    "done",
    "child",
    1,
    "completed",
    "2026-11-01T10:00:00.000Z",
    "2026-11-01T10:05:00.000Z",
    claude,
  );
  run.run(
    "stale",
    "old",
    1,
    "completed",
    "2026-10-01T10:00:00.000Z",
    "2026-10-01T10:01:00.000Z",
    claude,
  );
  run.run("live", "old", 2, "running", "2026-10-01T11:00:00.000Z", null, claude);
  const attempt = db.query("INSERT INTO orchestration_v2_projection_run_attempts VALUES (?, ?, ?)");
  attempt.run("done", 1, JSON.stringify({ nativeThreadId: "first-session" }));
  attempt.run("done", 2, JSON.stringify({ nativeThreadId: "retried-session" }));
  return db;
};

test("reads threads changed since the checkpoint and runs that changed or are still going", async () => {
  const { threads, runs } = await Effect.runPromise(
    readT3(fixture(), ":memory:", "2026-10-15T00:00:00.000Z", providerIds),
  );

  expect(threads).toEqual([
    {
      id: "child",
      title: "Fix [REDACTED]",
      project: "aqt",
      projectRoot: "/home/me/aqt",
      provider: "codex",
      createdBy: "agent",
      creationSource: "mcp",
      parentThreadId: "parent",
      relationship: "delegate",
      model: "gpt-6.1-sol",
      effort: "xhigh",
      fast: true,
      branch: "main",
      worktreePath: null,
      pullRequests: ["https://github.com/o/r/pull/1"],
      createdAt: "2026-11-01T10:00:00.000Z",
      updatedAt: "2026-11-01T11:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
    },
  ]);
  expect(runs.map((run) => [run.id, run.attempts, run.nativeSessionId])).toEqual([
    ["done", 2, "retried-session"],
    ["live", 0, null],
  ]);
  expect(runs[0]).toMatchObject({
    model: "claude-opus-5-5",
    effort: "high",
    fast: true,
    startedAt: "2026-11-01T10:00:02.000Z",
    completedAt: "2026-11-01T10:05:00.000Z",
  });
});

test("reads a thread with an option it does not know and leaves out excluded providers", async () => {
  const db = fixture();
  db.query(
    "INSERT INTO orchestration_v2_projection_threads VALUES (?, 'p1', ?, ?, ?, ?, NULL, NULL, ?)",
  ).run(
    "odd",
    "Odd options",
    "claudeAgent",
    "2026-11-02T10:00:00.000Z",
    "2026-11-02T10:00:00.000Z",
    JSON.stringify({ modelSelection: { model: "claude-opus-5-5", options: ["unexpected"] } }),
  );
  const read = (providers: ReadonlyArray<ProviderId>) =>
    Effect.runPromise(readT3(db, ":memory:", "2026-10-15T00:00:00.000Z", providers));

  const claudeOnly = await read(["claude"]);
  expect(claudeOnly.threads.map((thread) => [thread.id, thread.model, thread.effort])).toEqual([
    ["odd", "claude-opus-5-5", null],
  ]);
  expect(claudeOnly.runs.map((run) => run.id)).toEqual(["done", "live"]);
  const codexOnly = await read(["codex"]);
  expect([codexOnly.threads.map((thread) => thread.id), codexOnly.runs]).toEqual([["child"], []]);
});

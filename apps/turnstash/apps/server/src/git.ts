import type { CommitView } from "@aqt/turnstash-api";
import type {
  CommitBatch,
  CommitBatchResult,
  MachineId,
  RepositoryTask,
} from "@aqt/turnstash-core";
import { and, desc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { Array as Arr, Effect } from "effect";

import { Db, inTransaction } from "./db/client.ts";
import {
  commitLinks,
  commits,
  conversationMachines,
  conversations,
  modelRequests,
  repositoryPaths,
  valuations,
} from "./db/schema.ts";
import { excluded } from "./db/sql.ts";
import { number, projectCondition } from "./filters.ts";

export const repositoryTasks = Effect.fn("Git.repositoryTasks")(function* (machineId: MachineId) {
  const db = yield* Db;
  const rows = yield* db
    .select({
      path: conversations.projectPath,
      since: sql<string>`min(${conversations.startedAt})::text`,
    })
    .from(conversations)
    .innerJoin(conversationMachines, eq(conversationMachines.conversationId, conversations.id))
    .where(and(eq(conversationMachines.machineId, machineId), isNotNull(conversations.projectPath)))
    .groupBy(conversations.projectPath);
  return rows.flatMap((row): Array<RepositoryTask> =>
    row.path === null ? [] : [{ path: row.path, since: new Date(row.since).toISOString() }],
  );
});

// A commit belongs to the conversation whose window contains its author
// date, with a one-hour tail after the last message. The tightest window wins, then a branch match.
// Callers run this inside a transaction so readers never see the gap between delete and insert, and relink
// repos in sorted order so two transactions never take the same repos' link locks in opposite order.
const relinkRepo = Effect.fn("Git.relinkRepo")(function* (repo: string) {
  const db = yield* Db;
  yield* db.delete(commitLinks).where(eq(commitLinks.repo, repo));
  yield* db.execute(sql`
    INSERT INTO ${commitLinks} (repo, sha, conversation_id)
    SELECT DISTINCT ON (c.sha) c.repo, c.sha, v.id
    FROM ${commits} AS c
    JOIN (
      SELECT DISTINCT conv.id, conv.started_at, conv.ended_at, conv.git_branch
      FROM ${conversations} AS conv
      JOIN ${conversationMachines} AS cm ON cm.conversation_id = conv.id
      JOIN ${repositoryPaths} AS rp ON rp.machine_id = cm.machine_id AND rp.path = conv.project_path
      WHERE rp.repo = ${repo}
    ) AS v ON c.authored_at >= v.started_at AND c.authored_at <= v.ended_at + interval '1 hour'
    WHERE c.repo = ${repo}
    ORDER BY c.sha,
      (v.ended_at - v.started_at) ASC,
      (v.git_branch IS NOT NULL AND (c.ref = v.git_branch OR right(c.ref, length(v.git_branch) + 1) = '/' || v.git_branch)) DESC,
      v.started_at ASC,
      v.id ASC
    ON CONFLICT (repo, sha) DO UPDATE SET conversation_id = excluded.conversation_id, linked_at = now()
  `);
});

export const relinkConversations = Effect.fn("Git.relinkConversations")(function* (
  conversationIds: ReadonlyArray<string>,
) {
  if (conversationIds.length === 0) return;
  yield* inTransaction(
    Effect.gen(function* () {
      const db = yield* Db;
      const repos = yield* db
        .selectDistinct({ repo: repositoryPaths.repo })
        .from(repositoryPaths)
        .innerJoin(
          conversationMachines,
          eq(conversationMachines.machineId, repositoryPaths.machineId),
        )
        .innerJoin(
          conversations,
          and(
            eq(conversations.id, conversationMachines.conversationId),
            eq(conversations.projectPath, repositoryPaths.path),
          ),
        )
        .where(inArray(conversations.id, [...conversationIds]));
      for (const repo of repos.map((row) => row.repo).sort()) yield* relinkRepo(repo);
    }),
  );
});

export const applyCommitBatch = Effect.fn("Git.applyCommitBatch")(function* (
  machineId: MachineId,
  batch: CommitBatch,
) {
  const repos = new Set([
    ...batch.repositories.map((row) => row.repo),
    ...batch.commits.map((commit) => commit.repo),
  ]);
  yield* inTransaction(
    Effect.gen(function* () {
      const db = yield* Db;
      if (batch.repositories.length > 0) {
        yield* db
          .insert(repositoryPaths)
          .values(
            batch.repositories.map((row) => ({
              machineId,
              path: row.path,
              repo: row.repo,
              remote: row.remote,
            })),
          )
          .onConflictDoUpdate({
            target: [repositoryPaths.machineId, repositoryPaths.path],
            set: { ...excluded(repositoryPaths, ["repo", "remote"]), observedAt: sql`now()` },
          });
        yield* db
          .delete(commits)
          .where(
            notInArray(
              commits.repo,
              db.select({ repo: repositoryPaths.repo }).from(repositoryPaths),
            ),
          );
      }
      for (const rows of Arr.chunksOf(batch.commits, 500)) {
        yield* db
          .insert(commits)
          .values(
            rows.map((commit) => ({
              repo: commit.repo,
              sha: commit.sha,
              parents: [...commit.parents],
              authoredAt: new Date(commit.authoredAt),
              committedAt: new Date(commit.committedAt),
              subject: commit.subject,
              ref: commit.ref,
              onDefaultBranch: commit.onDefaultBranch,
            })),
          )
          .onConflictDoUpdate({
            target: [commits.repo, commits.sha],
            set: {
              ...excluded(commits, [
                "parents",
                "authoredAt",
                "committedAt",
                "subject",
                "ref",
                "onDefaultBranch",
              ]),
              observedAt: sql`now()`,
            },
          });
      }
      for (const repo of [...repos].sort()) yield* relinkRepo(repo);
    }),
  );
  return {
    repositories: batch.repositories.length,
    commits: batch.commits.length,
  } satisfies CommitBatchResult;
});

const remoteOf = sql<
  string | null
>`(SELECT rp.remote FROM ${repositoryPaths} AS rp WHERE rp.repo = ${commits.repo} AND rp.remote IS NOT NULL LIMIT 1)`;

interface CommitRow {
  readonly repo: string;
  readonly sha: string;
  readonly subject: string;
  readonly authoredAt: Date;
  readonly committedAt: Date;
  readonly ref: string;
  readonly onDefaultBranch: boolean;
  readonly remote: string | null;
  readonly conversationId: string;
}

const commitView = (row: CommitRow, costUsd: number): CommitView => ({
  repo: row.repo,
  sha: row.sha,
  subject: row.subject,
  authoredAt: row.authoredAt.toISOString(),
  committedAt: row.committedAt.toISOString(),
  ref: row.ref,
  onDefaultBranch: row.onDefaultBranch,
  remote: row.remote,
  conversationId: row.conversationId,
  costUsd,
});

const commitKey = (repo: string, sha: string) => `${repo}\u0000${sha}`;

// A commit is charged for its conversation's requests since that conversation's previous commit, so a
// conversation's commits add up to everything it spent before its last commit; later work stays uncharged.
const commitCosts = Effect.fn("Git.commitCosts")(function* (
  conversationIds: ReadonlyArray<string>,
) {
  if (conversationIds.length === 0) return new Map<string, number>();
  const db = yield* Db;
  const rows = yield* db.execute<{ repo: string; sha: string; cost_usd: string }>(
    sql`
    WITH windows AS (
      SELECT l.repo, l.sha, l.conversation_id, c.authored_at,
        lag(c.authored_at) OVER (PARTITION BY l.conversation_id ORDER BY c.authored_at, c.sha) AS previous_at
      FROM ${commitLinks} AS l
      JOIN ${commits} AS c ON c.repo = l.repo AND c.sha = l.sha
      WHERE l.conversation_id IN (${sql.join(
        conversationIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    )
    SELECT w.repo, w.sha, coalesce(sum(v.cost_usd), 0)::text AS cost_usd
    FROM windows AS w
    LEFT JOIN ${modelRequests} AS r ON r.conversation_id = w.conversation_id
      AND r.requested_at <= w.authored_at
      AND (w.previous_at IS NULL OR r.requested_at > w.previous_at)
    LEFT JOIN ${valuations} AS v ON v.request_id = r.id AND v.active
    GROUP BY w.repo, w.sha`,
    "objects",
  );
  return new Map(rows.map((row) => [commitKey(row.repo, row.sha), number(row.cost_usd)]));
});

const withCosts = Effect.fn("Git.withCosts")(function* (rows: ReadonlyArray<CommitRow>) {
  const costs = yield* commitCosts([...new Set(rows.map((row) => row.conversationId))]);
  return rows.map((row) => commitView(row, costs.get(commitKey(row.repo, row.sha)) ?? 0));
});

const linkedCommits = {
  repo: commits.repo,
  sha: commits.sha,
  subject: commits.subject,
  authoredAt: commits.authoredAt,
  committedAt: commits.committedAt,
  ref: commits.ref,
  onDefaultBranch: commits.onDefaultBranch,
  remote: remoteOf,
  conversationId: commitLinks.conversationId,
};

export const commitsForConversation = Effect.fn("Git.commitsForConversation")(function* (
  conversationId: string,
) {
  const db = yield* Db;
  const rows = yield* db
    .select(linkedCommits)
    .from(commitLinks)
    .innerJoin(commits, and(eq(commits.repo, commitLinks.repo), eq(commits.sha, commitLinks.sha)))
    .where(eq(commitLinks.conversationId, conversationId))
    .orderBy(desc(commits.authoredAt));
  return yield* withCosts(rows);
});

export const commitsForProject = Effect.fn("Git.commitsForProject")(function* (
  projectKey: string,
  limit = 50,
) {
  const db = yield* Db;
  const rows = yield* db
    .select(linkedCommits)
    .from(commitLinks)
    .innerJoin(commits, and(eq(commits.repo, commitLinks.repo), eq(commits.sha, commitLinks.sha)))
    .innerJoin(conversations, eq(conversations.id, commitLinks.conversationId))
    .where(projectCondition(projectKey))
    .orderBy(desc(commits.authoredAt))
    .limit(limit);
  return yield* withCosts(rows);
});

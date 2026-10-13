import {
  type CommitRecord,
  commitBatchLimits,
  isoTimestampOf,
  type MachineId,
  normalizeRemoteUrl,
  redact,
  type RepositoryPath,
  type RepositoryTask,
} from "@aqt/turnstash-core";
import { Array as Arr, Effect, FileSystem, Path, Result, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { ApiClient } from "./push.ts";
import { AgentState } from "./state.ts";

export class GitCommandFailed extends Schema.TaggedError<GitCommandFailed>()("GitCommandFailed", {
  args: Schema.Array(Schema.String),
  exitCode: Schema.Int,
  stderr: Schema.String,
}) {}

const git = Effect.fn("Git.run")(
  function* (cwd: string, args: ReadonlyArray<string>) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("git", args, { cwd, env: { GIT_TERMINAL_PROMPT: "0" }, extendEnv: true }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode,
      ],
      { concurrency: 3 },
    );
    if (exitCode !== 0)
      return yield* new GitCommandFailed({
        args: [...args],
        exitCode,
        stderr: stderr.trim().slice(0, 500),
      });
    return stdout.trimEnd();
  },
  Effect.scoped,
  Effect.timeout("60 seconds"),
);

const gitOrNull = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, args).pipe(Effect.catchTag("GitCommandFailed", () => Effect.succeed(null)));

export interface RepositoryIdentity {
  readonly key: string;
  readonly remote: string | null;
}

export const repositoryIdentity = Effect.fn("Git.identity")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* git(directory, [
    "rev-parse",
    "--is-inside-work-tree",
    "--git-common-dir",
  ]).pipe(
    Effect.catchTag("GitCommandFailed", (error) =>
      error.stderr.includes("not a git repository") ? Effect.succeed(null) : Effect.fail(error),
    ),
  );
  if (output === null) return null;
  const [inside, commonDir] = output.split("\n");
  if (inside !== "true" || commonDir === undefined || commonDir === "") return null;
  const resolved = path.resolve(directory, commonDir);
  const key = yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
  const remote = yield* gitOrNull(directory, ["remote", "get-url", "origin"]);
  return {
    key,
    remote: remote === null ? null : normalizeRemoteUrl(remote),
  } satisfies RepositoryIdentity;
});

const defaultBranchRef = Effect.fn("Git.defaultBranch")(function* (directory: string) {
  const symbolic = yield* gitOrNull(directory, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const named = symbolic === null ? [] : [symbolic.replace(/^origin\//, "")];
  for (const name of [...named, "main", "master"]) {
    for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
      if ((yield* gitOrNull(directory, ["rev-parse", "--verify", "--quiet", ref])) !== null)
        return ref;
    }
  }
  return "HEAD";
});

const shortRef = (ref: string): string =>
  ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
const logFormat = "--format=%H%x1f%P%x1f%aI%x1f%cI%x1f%S%x1f%s";

export type RepositoryCommit = Omit<CommitRecord, "repo">;

// --since alone stops traversing at the first old commit, so a clock-skewed tip would hide its ancestors;
// --since-as-filter keeps walking. Stashes and notes are excluded by listing only branch refs.
const branchRefs = ["--glob=refs/heads/*", "--glob=refs/remotes/*"];

export const readCommits = Effect.fn("Git.readCommits")(function* (
  directory: string,
  since: string,
) {
  const defaultRef = yield* defaultBranchRef(directory);
  if (
    defaultRef === "HEAD" &&
    (yield* gitOrNull(directory, ["rev-parse", "--verify", "--quiet", "HEAD"])) === null
  ) {
    // A repository with no commits yet has nothing to link; anything else must still fail loudly.
    yield* git(directory, ["rev-parse", "--git-dir"]);
    return [];
  }
  const onDefault = new Set(
    (yield* git(directory, ["log", defaultRef, `--since-as-filter=${since}`, "--format=%H"])).split(
      "\n",
    ),
  );
  const log = yield* git(directory, [
    "log",
    ...branchRefs,
    "--source",
    `--since-as-filter=${since}`,
    logFormat,
  ]);
  const commits: Array<RepositoryCommit> = [];
  for (const line of log.split("\n")) {
    const [sha, parents, authoredAt, committedAt, ref, subject] = line.split("\u001f");
    if (sha === undefined || sha === "" || authoredAt === undefined || committedAt === undefined)
      continue;
    const authored = isoTimestampOf(authoredAt);
    const committed = isoTimestampOf(committedAt);
    if (authored === undefined || committed === undefined) continue;
    commits.push({
      sha,
      parents: (parents ?? "").split(" ").filter((parent) => parent !== ""),
      authoredAt: authored,
      committedAt: committed,
      subject: redact(subject ?? "").text.slice(0, 200),
      ref: redact(shortRef(ref ?? "")).text,
      onDefaultBranch: onDefault.has(sha),
    });
  }
  return commits.sort((a, b) =>
    a.authoredAt < b.authoredAt ? -1 : a.authoredAt > b.authoredAt ? 1 : 0,
  );
});

export interface CommitSyncSummary {
  readonly repositories: number;
  readonly commits: number;
  readonly errors: ReadonlyArray<{ readonly path: string; readonly error: string }>;
}

const fingerprintOf = (commit: RepositoryCommit): string =>
  `${commit.ref}|${commit.onDefaultBranch ? 1 : 0}`;

const describeFailure = (failure: Error): string =>
  failure instanceof GitCommandFailed
    ? `git ${failure.args.join(" ")} exited ${failure.exitCode}: ${failure.stderr}`
    : String(failure);

interface RepositoryGroup {
  readonly identity: RepositoryIdentity;
  readonly directory: string;
  readonly paths: Array<string>;
  since: string;
}

const groupTasks = Effect.fn("Git.groupTasks")(function* (tasks: ReadonlyArray<RepositoryTask>) {
  const fs = yield* FileSystem.FileSystem;
  const groups = new Map<string, RepositoryGroup>();
  const errors: Array<{ path: string; error: string }> = [];
  for (const task of tasks) {
    if (!(yield* fs.exists(task.path).pipe(Effect.orElseSucceed(() => false)))) continue;
    const identity = yield* repositoryIdentity(task.path).pipe(Effect.result);
    if (Result.isFailure(identity)) {
      errors.push({ path: task.path, error: describeFailure(identity.failure) });
      continue;
    }
    if (identity.success === null) continue;
    const group = groups.get(identity.success.key) ?? {
      identity: identity.success,
      directory: task.path,
      paths: [],
      since: task.since,
    };
    group.paths.push(task.path);
    if (task.since < group.since) group.since = task.since;
    groups.set(identity.success.key, group);
  }
  return { groups: [...groups.values()], errors };
});

export const syncCommits = Effect.fn("Git.sync")(function* (
  client: ApiClient,
  machineId: MachineId,
) {
  const state = yield* AgentState.Service;
  const tasks = yield* client.ingest.repositories();
  const { groups, errors } = yield* groupTasks(tasks);
  let commits = 0;
  for (const group of groups) {
    const repo = group.identity.remote ?? `local:${machineId}:${group.identity.key}`;
    const repositories: Array<RepositoryPath> = group.paths.map((path) => ({
      path,
      repo,
      remote: group.identity.remote,
    }));
    const read = yield* readCommits(group.directory, group.since).pipe(Effect.result);
    if (Result.isFailure(read)) {
      errors.push({ path: group.directory, error: describeFailure(read.failure) });
      continue;
    }
    const known = yield* state.commitFingerprints(repo);
    const changed = read.success.filter(
      (commit) => known.get(commit.sha) !== fingerprintOf(commit),
    );
    const batches =
      changed.length === 0 ? [[]] : Arr.chunksOf(changed, commitBatchLimits.maxCommits);
    for (const [index, rows] of batches.entries()) {
      yield* client.ingest.pushCommits({
        payload: {
          machineId,
          repositories: index === 0 ? repositories : [],
          commits: rows.map((commit) => ({ repo, ...commit })),
        },
      });
      yield* state.rememberCommits(
        repo,
        rows.map((commit) => ({ sha: commit.sha, fingerprint: fingerprintOf(commit) })),
      );
      commits += rows.length;
    }
  }
  return { repositories: groups.length, commits, errors } satisfies CommitSyncSummary;
});

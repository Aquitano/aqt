import { expect, test } from "bun:test";
import { join } from "node:path";

import { readCommits, repositoryIdentity } from "../src/git.ts";
import { run, withDirectory } from "./support.ts";

const sh = (cwd: string, args: ReadonlyArray<string>, date: string) => {
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const result = Bun.spawnSync(["git", ...args], { cwd, env });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
};

test("a repository yields its commits with default-branch membership, merges and squashes included", () =>
  withDirectory(async (directory) => {
    const repo = join(directory, "repo");
    const t = (minute: number) => `2026-09-21T09:${String(minute).padStart(2, "0")}:00Z`;
    sh(directory, ["init", "-q", "-b", "main", "repo"], t(0));
    sh(repo, ["remote", "add", "origin", "git@github.com:acme/repo.git"], t(0));
    sh(repo, ["commit", "-q", "--allow-empty", "-m", "root"], t(0));
    sh(repo, ["checkout", "-q", "-b", "feature"], t(1));
    sh(repo, ["commit", "-q", "--allow-empty", "-m", "feature work"], t(1));
    sh(repo, ["checkout", "-q", "main"], t(2));
    sh(repo, ["merge", "-q", "--no-ff", "-m", "merge feature", "feature"], t(2));
    sh(repo, ["checkout", "-q", "-b", "squashed"], t(3));
    sh(repo, ["commit", "-q", "--allow-empty", "-m", "squash work"], t(3));
    sh(repo, ["checkout", "-q", "main"], t(4));
    sh(repo, ["commit", "-q", "--allow-empty", "-m", "squash merge"], t(4));
    sh(repo, ["checkout", "-q", "-b", "open"], t(5));
    sh(repo, ["commit", "-q", "--allow-empty", "-m", "unmerged"], t(5));
    await Bun.write(join(repo, "file.txt"), "one");
    sh(repo, ["add", "file.txt"], t(6));
    sh(repo, ["commit", "-q", "-m", "tracked file"], t(6));
    await Bun.write(join(repo, "file.txt"), "two");
    sh(repo, ["stash", "push", "-q"], t(7));
    const nested = join(repo, "packages", "nested");
    Bun.spawnSync(["mkdir", "-p", nested]);

    const identity = await run(repositoryIdentity(nested));
    expect(identity?.remote).toBe("github.com/acme/repo");
    expect(identity?.key).toBe(await run(repositoryIdentity(repo)).then((root) => root?.key));
    expect(await run(repositoryIdentity(directory))).toBeNull();

    const commits = await run(readCommits(repo, "2026-09-21T00:00:00Z"));
    const bySubject = new Map(commits.map((commit) => [commit.subject, commit]));
    expect(commits.map((commit) => commit.subject)).toEqual([
      "root",
      "feature work",
      "merge feature",
      "squash work",
      "squash merge",
      "unmerged",
      "tracked file",
    ]);
    expect(bySubject.get("merge feature")?.parents).toHaveLength(2);
    expect(bySubject.get("unmerged")).toMatchObject({
      ref: "open",
      onDefaultBranch: false,
      authoredAt: "2026-09-21T09:05:00.000Z",
    });
    expect(
      commits.filter((commit) => commit.onDefaultBranch).map((commit) => commit.subject),
    ).toEqual(["root", "feature work", "merge feature", "squash merge"]);
    expect(await run(readCommits(repo, "2026-09-21T09:04:30Z"))).toHaveLength(2);
    await expect(run(readCommits(directory, "2026-09-21T00:00:00Z"))).rejects.toThrow();
  }));

test("a repository without commits yields nothing instead of failing", () =>
  withDirectory(async (directory) => {
    sh(directory, ["init", "-q", "-b", "main", "empty"], "2026-09-21T09:00:00Z");
    expect(await run(readCommits(join(directory, "empty"), "2026-09-21T00:00:00Z"))).toEqual([]);
  }));

test("redacts secrets in commit subjects and refs before truncating or uploading", () =>
  withDirectory(async (directory) => {
    const date = "2026-09-21T09:00:00Z";
    const subject = `${"x".repeat(180)} password=${"s".repeat(100)}`;
    const ref = "feature/ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    sh(directory, ["init", "-q", "-b", ref], date);
    sh(directory, ["commit", "-q", "--allow-empty", "-m", subject], date);

    const commits = await run(readCommits(directory, "2026-09-21T00:00:00Z"));
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      subject: `${"x".repeat(180)} password=[REDACTED]`,
      ref: "feature/[REDACTED]",
      onDefaultBranch: true,
    });
  }));

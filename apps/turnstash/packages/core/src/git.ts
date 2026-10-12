import { Schema } from "effect";

import { IsoTimestamp, MachineId } from "./records.ts";

export const CommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));

export const RepositoryPath = Schema.Struct({
  path: Schema.NonEmptyString,
  repo: Schema.NonEmptyString,
  remote: Schema.NullOr(Schema.String),
});
export type RepositoryPath = typeof RepositoryPath.Type;

export const CommitRecord = Schema.Struct({
  repo: Schema.NonEmptyString,
  sha: CommitSha,
  parents: Schema.Array(CommitSha),
  authoredAt: IsoTimestamp,
  committedAt: IsoTimestamp,
  subject: Schema.String,
  ref: Schema.String,
  onDefaultBranch: Schema.Boolean,
});
export type CommitRecord = typeof CommitRecord.Type;

export const commitBatchLimits = { maxCommits: 2000 } as const;

export const CommitBatch = Schema.Struct({
  machineId: MachineId,
  repositories: Schema.Array(RepositoryPath),
  commits: Schema.Array(CommitRecord).check(Schema.isMaxLength(commitBatchLimits.maxCommits)),
});
export type CommitBatch = typeof CommitBatch.Type;

export const CommitBatchResult = Schema.Struct({
  repositories: Schema.Natural,
  commits: Schema.Natural,
});
export type CommitBatchResult = typeof CommitBatchResult.Type;

export const RepositoryTask = Schema.Struct({ path: Schema.NonEmptyString, since: IsoTimestamp });
export type RepositoryTask = typeof RepositoryTask.Type;

const maxIdentityLength = 200;
const identitySegment = /^[A-Za-z0-9._~-]+$/;

// Credentials are split off before host matching so a token can never land in the identity.
export const normalizeRemoteUrl = (url: string): string | null => {
  const trimmed = url.trim();
  if (trimmed === "" || /^[a-zA-Z]:[\\/]/.test(trimmed)) return null;

  let host: string;
  let path: string;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.protocol === "file:" || parsed.hostname === "") return null;
    host = parsed.hostname;
    path = parsed.pathname;
  } else {
    const at = trimmed.indexOf("@");
    const rest = at >= 0 ? trimmed.slice(at + 1) : trimmed;
    const scpLike = /^([^:/\\]{2,}):(?!\/\/)(.+)$/.exec(rest);
    if (scpLike === null || scpLike[1] === undefined || scpLike[2] === undefined) return null;
    host = scpLike[1];
    path = scpLike[2];
  }

  const segments = path
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (segments.some((segment) => !identitySegment.test(segment))) return null;
  const identity = `${host.toLowerCase()}/${segments.join("/")}`;
  return identity.length > maxIdentityLength ? null : identity;
};

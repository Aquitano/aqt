import { Schema } from "effect";

import { IsoTimestamp, MachineId, NulFreeString } from "./records.ts";

const Text = Schema.NullOr(NulFreeString);
const Timestamp = Schema.NullOr(IsoTimestamp);

// The model a T3 thread or run was started with, as T3 Code's model picker records it.
const ModelSelection = {
  model: Text,
  effort: Text,
  fast: Schema.NullOr(Schema.Boolean),
};

export const T3Thread = Schema.Struct({
  id: NulFreeString,
  title: Text,
  project: Text,
  projectRoot: Text,
  provider: Text,
  createdBy: Text,
  creationSource: Text,
  parentThreadId: Text,
  relationship: Text,
  ...ModelSelection,
  branch: Text,
  worktreePath: Text,
  pullRequests: Schema.Array(NulFreeString),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  archivedAt: Timestamp,
  deletedAt: Timestamp,
});
export type T3Thread = typeof T3Thread.Type;

// One user message's run of the agent. nativeSessionId is the Claude Code session or Codex rollout the run
// wrote, which is how a run finds its archived conversation.
export const T3Run = Schema.Struct({
  id: NulFreeString,
  threadId: NulFreeString,
  ordinal: Schema.Int,
  provider: Text,
  status: NulFreeString,
  ...ModelSelection,
  requestedAt: IsoTimestamp,
  startedAt: Timestamp,
  completedAt: Timestamp,
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nativeSessionId: Text,
});
export type T3Run = typeof T3Run.Type;

export const t3BatchLimits = { maxRows: 500 } as const;

export const T3Batch = Schema.Struct({
  machineId: MachineId,
  threads: Schema.Array(T3Thread).check(Schema.isMaxLength(t3BatchLimits.maxRows)),
  runs: Schema.Array(T3Run).check(Schema.isMaxLength(t3BatchLimits.maxRows)),
});
export type T3Batch = typeof T3Batch.Type;

export const T3BatchResult = Schema.Struct({ threads: Schema.Natural, runs: Schema.Natural });
export type T3BatchResult = typeof T3BatchResult.Type;

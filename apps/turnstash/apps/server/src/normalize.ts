import {
  analysisVersion,
  analyzeConversation,
  type ConversationAnalysis,
} from "@aqt/turnstash-analysis";
import {
  type NormalizedConversation,
  type ProviderId,
  RecordKey,
  type SourceRecordRow,
  StreamId,
} from "@aqt/turnstash-core";
import { resolveModel } from "@aqt/turnstash-pricing";
import { and, asc, eq, lte, or, type SQL, sql } from "drizzle-orm";
import { Array as Arr, Cause, Effect, Exit, Metric, Predicate } from "effect";

import { lockConversations } from "./conversation-locks.ts";
import { Db, inTransaction } from "./db/client.ts";
import { failureSummary } from "./db/errors.ts";
import {
  bookmarks,
  conversationMachines,
  conversationTurns,
  conversations,
  dirtyConversations,
  messages,
  modelRequests,
  sourceRecords,
  sourceStreams,
  toolExecutions,
  tombstones,
  valuations,
} from "./db/schema.ts";
import { differsFromExcluded, excluded, textValues, uuidValues } from "./db/sql.ts";
import { unknownProject } from "./filters.ts";
import { relinkConversations } from "./git.ts";
import { Normalizers } from "./registry.ts";
import { scrubJson, scrubOptional, scrubText } from "./scrub.ts";
import { normalizeFailures } from "./telemetry.ts";
import { activeCatalog } from "./valuation.ts";

const homePrefix = /^(?:[a-z]:)?\/?(?:users|home)\/[^/]+\//i;

export const homeRelative = (projectPath: string): string => {
  const slashed = projectPath.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  const stripped = slashed.replace(homePrefix, "");
  if (stripped !== "" && stripped !== slashed) return stripped;
  return slashed.replace(/^[a-z]:\/?/i, "") || slashed || unknownProject;
};

// Claude Code names project dirs with "/" replaced by "-", so both spellings must share one key.
export const projectKeyOf = (projectPath: string): string =>
  homeRelative(projectPath).toLowerCase().replace(/[/-]+/g, "-").replace(/^-|-$/g, "") ||
  unknownProject;

const messageColumns = [
  "seq",
  "turnIndex",
  "role",
  "parentMessageKey",
  "createdAt",
  "parts",
  "text",
] as const;
const toolColumns = [
  "messageKey",
  "name",
  "input",
  "output",
  "status",
  "startedAt",
  "endedAt",
] as const;
const requestColumns = [
  "messageKey",
  "modelRaw",
  "modelId",
  "route",
  "routeHint",
  "requestedAt",
  "inputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheWrite1hTokens",
  "outputTokens",
  "reasoningTokens",
  "usageBasis",
  "speed",
  "sourceRecordKey",
] as const;
const turnColumns = [
  "firstSeq",
  "startedAt",
  "userExcerpt",
  "category",
  "skill",
  "primaryModelId",
  "tools",
  "skills",
  "mcpServers",
  "commands",
  "edits",
  "retries",
  "analysisVersion",
] as const;

const loadRecords = Effect.fn("Normalize.loadRecords")(function* (
  provider: ProviderId,
  conversationKey: string,
) {
  const db = yield* Db;
  return yield* db
    .select({
      streamId: sourceStreams.streamId,
      machineId: sourceStreams.machineId,
      recordKey: sourceRecords.recordKey,
      payload: sourceRecords.payload,
      observedAt: sourceRecords.observedAt,
      redactions: sourceRecords.redactions,
    })
    .from(sourceRecords)
    .innerJoin(sourceStreams, eq(sourceStreams.id, sourceRecords.streamRef))
    .where(
      and(eq(sourceRecords.provider, provider), eq(sourceRecords.conversationKey, conversationKey)),
    );
});

const upsertConversationRow = Effect.fn("Normalize.upsertConversationRow")(function* (
  provider: ProviderId,
  normalized: NormalizedConversation,
  parserVersion: number,
) {
  const db = yield* Db;
  const parentKey = normalized.parentConversationKey ?? null;
  const [parent] =
    parentKey === null
      ? []
      : yield* db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(eq(conversations.provider, provider), eq(conversations.conversationKey, parentKey)),
          )
          .limit(1);
  const values = {
    provider,
    conversationKey: normalized.conversationKey,
    parentId: parent?.id ?? null,
    parentKey,
    title: scrubOptional(normalized.title),
    projectPath: scrubOptional(normalized.projectPath),
    projectKey:
      normalized.projectPath === undefined ? null : projectKeyOf(scrubText(normalized.projectPath)),
    gitBranch: scrubOptional(normalized.gitBranch),
    clientVersion: scrubOptional(normalized.clientVersion),
    startedAt: new Date(normalized.startedAt),
    endedAt: new Date(normalized.endedAt),
    messageCount: normalized.messages.length,
    requestCount: normalized.requests.length,
    parserVersion,
    normalizedAt: sql`now()`,
  };
  const [row] = yield* db
    .insert(conversations)
    .values(values)
    .onConflictDoUpdate({
      target: [conversations.provider, conversations.conversationKey],
      set: values,
    })
    .returning({ id: conversations.id });
  if (row === undefined) return yield* Effect.die("conversation upsert returned no row");
  yield* db
    .update(conversations)
    .set({ parentId: row.id })
    .where(
      and(
        eq(conversations.provider, provider),
        eq(conversations.parentKey, normalized.conversationKey),
        sql`${conversations.parentId} IS DISTINCT FROM ${row.id}::uuid`,
      ),
    );
  return row.id;
});

const replaceMessages = Effect.fn("Normalize.replaceMessages")(function* (
  conversationId: string,
  normalized: NormalizedConversation,
  analysis: ConversationAnalysis,
) {
  const db = yield* Db;
  const keys = normalized.messages.map((message) => message.messageKey);
  yield* db
    .delete(bookmarks)
    .where(
      and(
        eq(bookmarks.conversationId, conversationId),
        or(eq(bookmarks.kind, "message"), eq(bookmarks.kind, "turn")),
        keys.length === 0 ? undefined : sql`${bookmarks.messageKey} NOT IN (${textValues(keys)})`,
      ),
    );
  yield* db
    .delete(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        keys.length === 0 ? undefined : sql`${messages.messageKey} NOT IN (${textValues(keys)})`,
      ),
    );
  for (const batch of Arr.chunksOf(normalized.messages, 200)) {
    yield* db
      .insert(messages)
      .values(
        batch.map((message) => ({
          conversationId,
          messageKey: message.messageKey,
          seq: message.seq,
          turnIndex: analysis.turnOfMessage.get(message.messageKey) ?? null,
          role: message.role,
          parentMessageKey: message.parentMessageKey ?? null,
          createdAt: new Date(message.createdAt),
          parts: scrubJson(message.parts),
          text: scrubText(message.text),
        })),
      )
      .onConflictDoUpdate({
        target: [messages.conversationId, messages.messageKey],
        set: excluded(messages, messageColumns),
        setWhere: differsFromExcluded(messages, messageColumns),
      });
  }
});

const replaceToolExecutions = Effect.fn("Normalize.replaceToolExecutions")(function* (
  conversationId: string,
  normalized: NormalizedConversation,
) {
  const db = yield* Db;
  const keys = normalized.toolExecutions.map((tool) => tool.toolKey);
  yield* db
    .delete(toolExecutions)
    .where(
      and(
        eq(toolExecutions.conversationId, conversationId),
        keys.length === 0 ? undefined : sql`${toolExecutions.toolKey} NOT IN (${textValues(keys)})`,
      ),
    );
  for (const batch of Arr.chunksOf(normalized.toolExecutions, 200)) {
    yield* db
      .insert(toolExecutions)
      .values(
        batch.map((tool) => ({
          conversationId,
          toolKey: tool.toolKey,
          messageKey: tool.messageKey ?? null,
          name: tool.name,
          input: scrubJson(tool.input),
          output: tool.output === null ? null : scrubText(tool.output),
          status: tool.status,
          startedAt: tool.startedAt === undefined ? null : new Date(tool.startedAt),
          endedAt: tool.endedAt === undefined ? null : new Date(tool.endedAt),
        })),
      )
      .onConflictDoUpdate({
        target: [toolExecutions.conversationId, toolExecutions.toolKey],
        set: excluded(toolExecutions, toolColumns),
        setWhere: differsFromExcluded(toolExecutions, toolColumns),
      });
  }
});

// Only rows that changed are rewritten, so only their valuations are dropped.
const replaceRequests = Effect.fn("Normalize.replaceRequests")(function* (
  conversationId: string,
  provider: ProviderId,
  normalized: NormalizedConversation,
) {
  const db = yield* Db;
  const catalog = yield* activeCatalog();
  const keys = normalized.requests.map((request) => request.requestKey);
  yield* db
    .delete(modelRequests)
    .where(
      and(
        eq(modelRequests.conversationId, conversationId),
        keys.length === 0
          ? undefined
          : sql`${modelRequests.requestKey} NOT IN (${textValues(keys)})`,
      ),
    );
  const changedIds: Array<string> = [];
  for (const batch of Arr.chunksOf(normalized.requests, 200)) {
    const rows = yield* db
      .insert(modelRequests)
      .values(
        batch.map((request) => {
          const resolved = resolveModel(catalog, request.modelRaw, request.routeHint);
          return {
            conversationId,
            provider,
            messageKey: request.messageKey ?? null,
            requestKey: request.requestKey,
            modelRaw: request.modelRaw,
            modelId: resolved.modelId,
            route: resolved.route?.id ?? null,
            routeHint: request.routeHint ?? null,
            requestedAt: new Date(request.requestedAt),
            inputTokens: request.usage.inputTokens,
            cacheReadTokens: request.usage.cacheReadTokens,
            cacheWriteTokens: request.usage.cacheWriteTokens,
            cacheWrite1hTokens: request.usage.cacheWrite1hTokens,
            outputTokens: request.usage.outputTokens,
            reasoningTokens: request.usage.reasoningTokens,
            usageBasis: request.usageBasis,
            speed: request.speed ?? null,
            sourceRecordKey: request.sourceRecordKey ?? null,
          };
        }),
      )
      .onConflictDoUpdate({
        target: [modelRequests.conversationId, modelRequests.requestKey],
        set: excluded(modelRequests, requestColumns),
        setWhere: differsFromExcluded(modelRequests, requestColumns),
      })
      .returning({ id: modelRequests.id });
    changedIds.push(...rows.map((row) => row.id));
  }
  if (changedIds.length > 0)
    yield* db.delete(valuations).where(sql`${valuations.requestId} IN (${uuidValues(changedIds)})`);
});

// Turn indexes shift whenever messages are re-ordered; they are written apart from the request upsert so a
// shifted index never invalidates a valuation.
const replaceTurns = Effect.fn("Normalize.replaceTurns")(function* (
  conversationId: string,
  normalized: NormalizedConversation,
  analysis: ConversationAnalysis,
) {
  const db = yield* Db;
  const catalog = yield* activeCatalog();
  for (const batch of Arr.chunksOf(normalized.requests, 500)) {
    const values = batch.map(
      (request) =>
        sql`(${request.requestKey}, ${analysis.turnOfRequest.get(request.requestKey) ?? null}::int)`,
    );
    yield* db.execute(sql`
      UPDATE ${modelRequests} AS r SET turn_index = v.turn_index
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(request_key, turn_index)
      WHERE r.conversation_id = ${conversationId}::uuid AND r.request_key = v.request_key AND r.turn_index IS DISTINCT FROM v.turn_index`);
  }
  const requestByKey = new Map(normalized.requests.map((request) => [request.requestKey, request]));
  yield* db
    .delete(conversationTurns)
    .where(
      and(
        eq(conversationTurns.conversationId, conversationId),
        sql`${conversationTurns.turnIndex} >= ${analysis.turns.length}`,
      ),
    );
  for (const batch of Arr.chunksOf(analysis.turns, 200)) {
    yield* db
      .insert(conversationTurns)
      .values(
        batch.map((turn) => {
          const first = turn.requestKeys
            .map((key) => requestByKey.get(key))
            .find((request) => request !== undefined);
          return {
            conversationId,
            turnIndex: turn.index,
            firstSeq: turn.firstSeq,
            startedAt: new Date(turn.startedAt),
            userExcerpt: scrubText(turn.userExcerpt),
            category: turn.category,
            skill: turn.skill,
            primaryModelId:
              first === undefined
                ? null
                : resolveModel(catalog, first.modelRaw, first.routeHint).modelId,
            tools: [...turn.tools],
            skills: [...turn.skills],
            mcpServers: [...turn.mcpServers],
            commands: [...turn.commands],
            edits: turn.edits,
            retries: turn.retries,
            analysisVersion,
          };
        }),
      )
      .onConflictDoUpdate({
        target: [conversationTurns.conversationId, conversationTurns.turnIndex],
        set: excluded(conversationTurns, turnColumns),
        setWhere: differsFromExcluded(conversationTurns, turnColumns),
      });
  }
});

const upsertConversation = Effect.fn("Normalize.upsertConversation")(function* (
  provider: ProviderId,
  normalized: NormalizedConversation,
  parserVersion: number,
  machineIds: ReadonlyArray<string>,
) {
  const db = yield* Db;
  const conversationId = yield* upsertConversationRow(provider, normalized, parserVersion);
  if (machineIds.length > 0) {
    yield* db
      .insert(conversationMachines)
      .values(machineIds.map((machineId) => ({ conversationId, machineId })))
      .onConflictDoNothing();
  }
  const analysis = analyzeConversation(normalized);
  yield* replaceMessages(conversationId, normalized, analysis);
  yield* replaceToolExecutions(conversationId, normalized);
  yield* replaceRequests(conversationId, provider, normalized);
  yield* replaceTurns(conversationId, normalized, analysis);
  return conversationId;
});

export const normalizeConversation = Effect.fn("Normalize.conversation")(function* (
  provider: ProviderId,
  conversationKey: string,
) {
  const db = yield* Db;
  const normalizers = yield* Normalizers;
  const normalizer = normalizers[provider];
  yield* lockConversations([{ provider, conversationKey }]);
  const deleted = yield* db
    .select({ conversationKey: tombstones.conversationKey })
    .from(tombstones)
    .where(and(eq(tombstones.provider, provider), eq(tombstones.conversationKey, conversationKey)));
  if (deleted.length > 0) return null;
  const records = yield* loadRecords(provider, conversationKey);
  const rows = records.map((row): SourceRecordRow => ({
    streamId: StreamId.make(row.streamId),
    recordKey: RecordKey.make(row.recordKey),
    payload: row.payload,
    observedAt: row.observedAt.toISOString(),
  }));
  const normalized = records.length === 0 ? null : normalizer.normalize(conversationKey, rows);
  if (normalized === null) {
    yield* db
      .delete(conversations)
      .where(
        and(
          eq(conversations.provider, provider),
          eq(conversations.conversationKey, conversationKey),
        ),
      );
    return null;
  }
  const machineIds = [...new Set(records.map((row) => row.machineId))];
  return yield* upsertConversation(provider, normalized, normalizer.parserVersion, machineIds);
}, inTransaction);

// A conversation is stale when its parser or its turn analysis predates the code now running.
export const queueStale = Effect.fn("Normalize.queueStale")(function* () {
  const db = yield* Db;
  const normalizers = yield* Normalizers;
  const parsers = Object.entries(normalizers).map(
    ([provider, normalizer]) => sql`(${provider}, ${normalizer.parserVersion}::int)`,
  );
  const queued = yield* db.execute<{ count: number }>(
    sql`
    WITH queued AS (
      INSERT INTO ${dirtyConversations} (provider, conversation_key, marked_at)
      SELECT c.provider, c.conversation_key, now()
      FROM ${conversations} AS c
      LEFT JOIN (VALUES ${sql.join(parsers, sql`, `)}) AS p(provider, version) ON p.provider = c.provider
      WHERE c.parser_version < p.version
        OR EXISTS (
          SELECT 1 FROM ${conversationTurns} AS t
          WHERE t.conversation_id = c.id AND t.analysis_version < ${analysisVersion}
        )
      ON CONFLICT (provider, conversation_key) DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::int AS count FROM queued`,
    "objects",
  );
  return queued[0]?.count ?? 0;
});

// Doubles per failed attempt, from one minute up to six hours; new records for the conversation reset it.
const retryDelayMinutes = (attempts: number) => Math.min(2 ** (attempts - 1), 360);

const errorName = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  if (Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)) return error._tag;
  return error instanceof Error ? error.name : "Unknown";
};

export const hasDueConversations = Effect.fn("Normalize.hasDue")(function* () {
  const db = yield* Db;
  const due = yield* db
    .select({ one: sql`1` })
    .from(dirtyConversations)
    .where(lte(dirtyConversations.markedAt, sql`now()`))
    .limit(1);
  return due.length > 0;
});

export const normalizeDirty = Effect.fn("Normalize.dirty")(function* (limit: number) {
  const db = yield* Db;
  // JS dates drop the microseconds Postgres stores, so the mark is carried as text to delete exactly what was read.
  const dirty = yield* db
    .select({
      provider: dirtyConversations.provider,
      conversationKey: dirtyConversations.conversationKey,
      markedAt: sql<string>`${dirtyConversations.markedAt}::text`,
      attempts: dirtyConversations.attempts,
    })
    .from(dirtyConversations)
    .where(lte(dirtyConversations.markedAt, sql`now()`))
    .orderBy(asc(dirtyConversations.markedAt))
    .limit(limit);
  const normalizedIds: Array<string> = [];
  const done: Array<SQL | undefined> = [];
  for (const item of dirty) {
    const outcome = yield* normalizeConversation(item.provider, item.conversationKey).pipe(
      Effect.exit,
    );
    const identity = and(
      eq(dirtyConversations.provider, item.provider),
      eq(dirtyConversations.conversationKey, item.conversationKey),
    );
    if (Exit.isFailure(outcome)) {
      if (Cause.hasInterrupts(outcome.cause)) return yield* Effect.failCause(outcome.cause);
      const attempts = item.attempts + 1;
      const delayMinutes = retryDelayMinutes(attempts);
      yield* Metric.update(
        Metric.withAttributes(normalizeFailures, {
          provider: item.provider,
          error: errorName(outcome.cause),
        }),
        1,
      );
      yield* Effect.logWarning("normalize failed, retrying later", {
        provider: item.provider,
        conversationKey: item.conversationKey,
        attempts,
        delayMinutes,
        error: errorName(outcome.cause),
        ...failureSummary(outcome.cause),
      });
      yield* db
        .update(dirtyConversations)
        .set({ markedAt: sql`now() + make_interval(mins => ${delayMinutes})`, attempts })
        .where(and(identity, sql`${dirtyConversations.markedAt} = ${item.markedAt}::timestamptz`));
      continue;
    }
    if (outcome.value !== null) normalizedIds.push(outcome.value);
    done.push(and(identity, sql`${dirtyConversations.markedAt} = ${item.markedAt}::timestamptz`));
  }
  // Links are rebuilt before the marks go, so a crash in between re-normalizes instead of leaving stale links.
  yield* relinkConversations(normalizedIds);
  if (done.length > 0) yield* db.delete(dirtyConversations).where(or(...done));
  return dirty.length;
});

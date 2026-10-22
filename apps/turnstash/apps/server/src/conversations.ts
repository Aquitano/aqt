import {
  type ConversationDetail,
  type ConversationListQuery,
  type ConversationPage,
  type ConversationSummary,
  type MessagePage,
  type MessageQuery,
  type MessageView,
  NotFound,
  type RequestDetail,
  type RequestSummary,
  type ToolExecutionView,
} from "@aqt/turnstash-api";
import { findPrice } from "@aqt/turnstash-pricing";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { Effect } from "effect";

import { conversationTurnViews } from "./analysis.ts";
import { deleteUnlinkedBlobs } from "./blobs.ts";
import { lockConversations } from "./conversation-locks.ts";
import { Db, inTransaction } from "./db/client.ts";
import {
  conversationMachines,
  conversations,
  machines,
  messages,
  modelRequests,
  sourceRecords,
  sourceStreams,
  toolExecutions,
  tombstones,
  valuations,
} from "./db/schema.ts";
import { activeValuation, conversationConditions, number } from "./filters.ts";
import { commitsForConversation } from "./git.ts";
import { activeCatalog } from "./valuation.ts";

const costByConversation = (db: Db["Service"], ids: ReadonlyArray<string>) =>
  db
    .select({
      conversationId: modelRequests.conversationId,
      costUsd: sql<string>`coalesce(sum(${valuations.costUsd}), 0)`,
    })
    .from(modelRequests)
    .leftJoin(valuations, activeValuation)
    .where(inArray(modelRequests.conversationId, ids))
    .groupBy(modelRequests.conversationId);

export const conversationSummaries = Effect.fn("Conversations.summaries")(function* (
  ids: ReadonlyArray<string>,
) {
  if (ids.length === 0) return [];
  const db = yield* Db;
  const rows = yield* db.select().from(conversations).where(inArray(conversations.id, ids));
  const costs = yield* costByConversation(db, ids);
  const machinesOf = yield* db
    .select()
    .from(conversationMachines)
    .where(inArray(conversationMachines.conversationId, ids));
  const costMap = new Map(costs.map((row) => [row.conversationId, number(row.costUsd)]));
  const machinesMap = new Map<string, string[]>();
  for (const link of machinesOf) {
    let list = machinesMap.get(link.conversationId);
    if (list === undefined) {
      list = [];
      machinesMap.set(link.conversationId, list);
    }
    list.push(link.machineId);
  }
  return rows.map((row): ConversationSummary => ({
    id: row.id,
    provider: row.provider,
    conversationKey: row.conversationKey,
    parentId: row.parentId,
    title: row.title,
    projectKey: row.projectKey,
    projectPath: row.projectPath,
    gitBranch: row.gitBranch,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    messageCount: row.messageCount,
    requestCount: row.requestCount,
    costUsd: costMap.get(row.id) ?? 0,
    machineIds: machinesMap.get(row.id) ?? [],
  }));
});

const decodeCursor = (
  cursor: string | undefined,
): { readonly startedAt: Date; readonly id: string } | null => {
  if (cursor === undefined) return null;
  const [time, id] = cursor.split("|");
  if (time === undefined || id === undefined) return null;
  const startedAt = new Date(Number(time));
  return Number.isNaN(startedAt.getTime()) ? null : { startedAt, id };
};

const containing = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

export const listConversations = Effect.fn("Conversations.list")(function* (
  query: ConversationListQuery,
) {
  const db = yield* Db;
  const limit = query.limit ?? 50;
  const cursor = decodeCursor(query.cursor);
  const rows = yield* db
    .select({ id: conversations.id, startedAt: conversations.startedAt })
    .from(conversations)
    .where(
      and(
        conversationConditions(query),
        query.q === undefined
          ? undefined
          : or(
              ilike(conversations.title, containing(query.q)),
              ilike(conversations.projectPath, containing(query.q)),
              ilike(conversations.conversationKey, containing(query.q)),
            ),
        cursor === null
          ? undefined
          : or(
              lt(conversations.startedAt, cursor.startedAt),
              and(eq(conversations.startedAt, cursor.startedAt), lt(conversations.id, cursor.id)),
            ),
      ),
    )
    .orderBy(desc(conversations.startedAt), desc(conversations.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const summaries = yield* conversationSummaries(page.map((row) => row.id));
  const last = page[page.length - 1];
  const summaryMap = new Map(summaries.map((summary) => [summary.id, summary]));
  return {
    items: page
      .map((row) => summaryMap.get(row.id))
      .filter((summary): summary is ConversationSummary => summary !== undefined),
    nextCursor:
      rows.length > limit && last !== undefined ? `${last.startedAt.getTime()}|${last.id}` : null,
  } satisfies ConversationPage;
});

// Copilot's session store can leave a long session's every request without a message.
const requestsWithoutMessageShown = 100;

export const getConversation = Effect.fn("Conversations.get")(function* (id: string) {
  const db = yield* Db;
  const [summary] = yield* conversationSummaries([id]);
  if (summary === undefined) return yield* new NotFound({ entity: "conversation", id });
  const children = yield* db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.parentId, id));
  const childSummaries = yield* conversationSummaries(children.map((row) => row.id));
  const machinesOf =
    summary.machineIds.length === 0
      ? []
      : yield* db
          .select({ id: machines.id, name: machines.name })
          .from(machines)
          .where(inArray(machines.id, [...summary.machineIds]))
          .orderBy(machines.name);
  const byModel = yield* db
    .select({
      modelId: modelRequests.modelId,
      route: modelRequests.route,
      requests: count(),
      costUsd: sql<string>`coalesce(sum(${valuations.costUsd}), 0)`,
      inputTokens: sql<string>`coalesce(sum(${modelRequests.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${modelRequests.outputTokens}), 0)`,
      cacheReadTokens: sql<string>`coalesce(sum(${modelRequests.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<string>`coalesce(sum(${modelRequests.cacheWriteTokens} + ${modelRequests.cacheWrite1hTokens}), 0)`,
    })
    .from(modelRequests)
    .leftJoin(valuations, activeValuation)
    .where(eq(modelRequests.conversationId, id))
    .groupBy(modelRequests.modelId, modelRequests.route);
  const [redactions] = yield* db
    .select({ total: sql<string>`coalesce(sum(${sourceRecords.redactions}), 0)` })
    .from(sourceRecords)
    .where(
      and(
        eq(sourceRecords.provider, summary.provider),
        eq(sourceRecords.conversationKey, summary.conversationKey),
      ),
    );
  const commits = yield* commitsForConversation(id);
  const turns = yield* conversationTurnViews(id);
  const withoutMessage = yield* db
    .select({
      request: modelRequests,
      valuation: { costUsd: valuations.costUsd, unpricedReason: valuations.unpricedReason },
      total: sql<number>`count(*) over ()`,
    })
    .from(modelRequests)
    .leftJoin(valuations, activeValuation)
    .leftJoin(
      messages,
      and(
        eq(messages.conversationId, modelRequests.conversationId),
        eq(messages.messageKey, modelRequests.messageKey),
      ),
    )
    .where(and(eq(modelRequests.conversationId, id), isNull(messages.id)))
    .orderBy(asc(modelRequests.requestedAt), asc(modelRequests.requestKey))
    .limit(requestsWithoutMessageShown);
  return {
    conversation: summary,
    children: childSummaries,
    machines: machinesOf,
    byModel: byModel.map((row) => ({
      modelId: row.modelId,
      route: row.route,
      requests: number(row.requests),
      costUsd: number(row.costUsd),
      inputTokens: number(row.inputTokens),
      outputTokens: number(row.outputTokens),
      cacheReadTokens: number(row.cacheReadTokens),
      cacheWriteTokens: number(row.cacheWriteTokens),
    })),
    redactions: number(redactions?.total),
    commits,
    turns,
    requestsWithoutMessage: withoutMessage.map((entry) =>
      requestSummary(entry.request, entry.valuation ?? undefined),
    ),
    requestsWithoutMessageTotal: number(withoutMessage[0]?.total),
  } satisfies ConversationDetail;
});

const requestSummary = (
  row: typeof modelRequests.$inferSelect,
  valuation: Pick<typeof valuations.$inferSelect, "costUsd" | "unpricedReason"> | undefined,
): RequestSummary => ({
  id: row.id,
  conversationId: row.conversationId,
  messageKey: row.messageKey,
  requestKey: row.requestKey,
  modelRaw: row.modelRaw,
  modelId: row.modelId,
  route: row.route,
  requestedAt: row.requestedAt.toISOString(),
  inputTokens: row.inputTokens,
  cacheReadTokens: row.cacheReadTokens,
  cacheWriteTokens: row.cacheWriteTokens,
  cacheWrite1hTokens: row.cacheWrite1hTokens,
  outputTokens: row.outputTokens,
  reasoningTokens: row.reasoningTokens,
  usageBasis: row.usageBasis,
  costUsd:
    valuation?.costUsd === null || valuation?.costUsd === undefined
      ? null
      : number(valuation.costUsd),
  unpricedReason: valuation?.unpricedReason ?? (valuation === undefined ? "pending" : null),
});

export const getMessages = Effect.fn("Conversations.messages")(function* (
  id: string,
  cursor: string | undefined,
  limit: number,
  target: Pick<MessageQuery, "message" | "before"> = {},
) {
  const db = yield* Db;
  const exists = yield* db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  if (exists.length === 0) return yield* new NotFound({ entity: "conversation", id });
  let startSeq: number | undefined;
  if (target.message !== undefined) {
    const [matched] = yield* db
      .select({ seq: messages.seq })
      .from(messages)
      .where(and(eq(messages.conversationId, id), eq(messages.messageKey, target.message)))
      .limit(1);
    if (matched === undefined)
      return yield* new NotFound({ entity: "message", id: target.message });
    const earlier = yield* db
      .select({ seq: messages.seq })
      .from(messages)
      .where(and(eq(messages.conversationId, id), lt(messages.seq, matched.seq)))
      .orderBy(desc(messages.seq))
      .limit(Math.floor(limit / 2));
    startSeq = earlier[earlier.length - 1]?.seq ?? matched.seq;
  }
  const afterSeq = cursor === undefined ? -1 : Number(cursor);
  const beforeSeq = target.before === undefined ? undefined : Number(target.before);
  const rows = yield* db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, id),
        beforeSeq !== undefined
          ? lt(messages.seq, beforeSeq)
          : startSeq !== undefined
            ? gte(messages.seq, startSeq)
            : gt(messages.seq, Number.isFinite(afterSeq) ? afterSeq : -1),
      ),
    )
    .orderBy(beforeSeq === undefined ? asc(messages.seq) : desc(messages.seq))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  if (beforeSeq !== undefined) page.reverse();
  const first = page[0];
  const last = page[page.length - 1];
  const hasEarlier =
    beforeSeq !== undefined
      ? rows.length > limit
      : first !== undefined &&
        (yield* db
          .select({ seq: messages.seq })
          .from(messages)
          .where(and(eq(messages.conversationId, id), lt(messages.seq, first.seq)))
          .limit(1)).length > 0;
  const hasLater =
    beforeSeq === undefined
      ? rows.length > limit
      : last !== undefined &&
        (yield* db
          .select({ seq: messages.seq })
          .from(messages)
          .where(and(eq(messages.conversationId, id), gt(messages.seq, last.seq)))
          .limit(1)).length > 0;
  const keys = page.map((row) => row.messageKey);
  const requests =
    keys.length === 0
      ? []
      : yield* db
          .select({
            request: modelRequests,
            valuation: { costUsd: valuations.costUsd, unpricedReason: valuations.unpricedReason },
          })
          .from(modelRequests)
          .leftJoin(valuations, activeValuation)
          .where(
            and(eq(modelRequests.conversationId, id), inArray(modelRequests.messageKey, keys)),
          );
  // A result part leaves its output to the tool execution, which belongs to the call's message.
  const resultKeys = [
    ...new Set(
      page.flatMap((row) =>
        row.parts.flatMap((part) => (part.type === "tool_result" ? [part.toolKey] : [])),
      ),
    ),
  ];
  const tools =
    keys.length === 0
      ? []
      : yield* db
          .select()
          .from(toolExecutions)
          .where(
            and(
              eq(toolExecutions.conversationId, id),
              or(
                inArray(toolExecutions.messageKey, keys),
                resultKeys.length === 0 ? undefined : inArray(toolExecutions.toolKey, resultKeys),
              ),
            ),
          );
  const requestsMap = new Map<string, typeof requests>();
  for (const entry of requests) {
    if (entry.request.messageKey === null) continue;
    let list = requestsMap.get(entry.request.messageKey);
    if (list === undefined) {
      list = [];
      requestsMap.set(entry.request.messageKey, list);
    }
    list.push(entry);
  }
  return {
    items: page.map((row): MessageView => ({
      id: row.id,
      messageKey: row.messageKey,
      seq: row.seq,
      role: row.role,
      parentMessageKey: row.parentMessageKey,
      createdAt: row.createdAt.toISOString(),
      parts: row.parts,
      requests: (requestsMap.get(row.messageKey) ?? []).map((entry) =>
        requestSummary(entry.request, entry.valuation ?? undefined),
      ),
    })),
    toolExecutions: tools.map((tool): ToolExecutionView => ({
      id: tool.id,
      toolKey: tool.toolKey,
      messageKey: tool.messageKey,
      name: tool.name,
      input: tool.input ?? null,
      output: tool.output,
      status: tool.status,
      startedAt: tool.startedAt?.toISOString() ?? null,
      endedAt: tool.endedAt?.toISOString() ?? null,
    })),
    previousCursor: hasEarlier && first !== undefined ? String(first.seq) : null,
    nextCursor: hasLater && last !== undefined ? String(last.seq) : null,
  } satisfies MessagePage;
});

export const getRequest = Effect.fn("Conversations.request")(function* (id: string) {
  const db = yield* Db;
  const [row] = yield* db.select().from(modelRequests).where(eq(modelRequests.id, id)).limit(1);
  if (row === undefined) return yield* new NotFound({ entity: "request", id });
  const [conversation] = yield* db
    .select()
    .from(conversations)
    .where(eq(conversations.id, row.conversationId))
    .limit(1);
  if (conversation === undefined)
    return yield* new NotFound({ entity: "conversation", id: row.conversationId });
  const history = yield* db
    .select()
    .from(valuations)
    .where(eq(valuations.requestId, id))
    .orderBy(desc(valuations.computedAt));
  const active = history.find((valuation) => valuation.active);
  const priceEntry = findPrice(yield* activeCatalog(), row.modelRaw);
  const source =
    row.sourceRecordKey === null
      ? []
      : yield* db
          .select({
            streamId: sourceStreams.streamId,
            recordKey: sourceRecords.recordKey,
            machineId: sourceStreams.machineId,
          })
          .from(sourceRecords)
          .innerJoin(sourceStreams, eq(sourceStreams.id, sourceRecords.streamRef))
          .where(
            and(
              eq(sourceRecords.provider, conversation.provider),
              eq(sourceRecords.conversationKey, conversation.conversationKey),
              eq(sourceRecords.recordKey, row.sourceRecordKey),
            ),
          )
          .limit(1);
  return {
    request: requestSummary(row, active),
    provider: conversation.provider,
    conversationKey: conversation.conversationKey,
    conversationTitle: conversation.title,
    valuations: history.map((valuation) => ({
      catalogVersion: valuation.catalogVersion,
      priceKey: valuation.priceKey,
      costUsd: valuation.costUsd === null ? null : number(valuation.costUsd),
      unpricedReason: valuation.unpricedReason,
      breakdown: valuation.breakdown,
      computedAt: valuation.computedAt.toISOString(),
      active: valuation.active,
    })),
    priceEntry:
      "kind" in priceEntry ? null : { priceKey: priceEntry.priceKey, ...priceEntry.costs },
    sourceRecord: source[0] ?? null,
  } satisfies RequestDetail;
});

export const deleteConversation = Effect.fn("Conversations.delete")(function* (id: string) {
  const db = yield* Db;
  const [row] = yield* db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  if (row === undefined) return yield* new NotFound({ entity: "conversation", id });
  yield* inTransaction(
    Effect.gen(function* () {
      const tx = yield* Db;
      yield* lockConversations([{ provider: row.provider, conversationKey: row.conversationKey }]);
      yield* tx
        .insert(tombstones)
        .values({
          provider: row.provider,
          conversationKey: row.conversationKey,
          reason: "deleted via api",
        })
        .onConflictDoUpdate({
          target: [tombstones.provider, tombstones.conversationKey],
          set: { deletedAt: sql`now()` },
        });
      yield* tx
        .delete(sourceRecords)
        .where(
          and(
            eq(sourceRecords.provider, row.provider),
            eq(sourceRecords.conversationKey, row.conversationKey),
          ),
        );
      yield* tx.delete(conversations).where(eq(conversations.id, id));
      yield* deleteUnlinkedBlobs();
    }),
  );
});

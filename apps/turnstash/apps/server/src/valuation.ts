import {
  BadRequest,
  NotFound,
  type PricingCatalogView,
  type PricingRuleView,
  type Repricing,
  type UnpricedModelRow,
} from "@aqt/turnstash-api";
import { type PricingRule, type PricingRules, ruleKey } from "@aqt/turnstash-core";
import {
  type Catalog,
  bundledEntries,
  CatalogEntries,
  catalogVersion,
  fetchLiteLLM,
  type LiteLLMDocument,
  makeCatalog,
  priceRequest,
  pricingVersion,
  refreshedEntries,
  repricedModels,
  resolveModel,
  withRules,
} from "@aqt/turnstash-pricing";
import {
  and,
  count,
  desc,
  eq,
  isNotNull,
  isNull,
  min,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { Effect, Schema } from "effect";

import { Db, inTransaction } from "./db/client.ts";
import {
  conversationTurns,
  modelRequests,
  pricingCatalogs,
  pricingRules,
  valuations,
} from "./db/schema.ts";
import { excluded, textValues, uuidValues } from "./db/sql.ts";
import { number } from "./filters.ts";

const decodeEntries = Schema.decodeUnknownSync(CatalogEntries);

const catalogLock = 7_365_742_020;

// Every change to which catalog is pending or active holds this lock for its whole transaction. Under READ
// COMMITTED a concurrent change would otherwise build on rules read before the other committed, or clear the
// pending flag only on the catalog rows its own statement can see. Taking it before any row lock also keeps an
// activation and the worker's swap, which both lock every catalog row, from deadlocking.
const inCatalogTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  inTransaction(
    Effect.andThen(
      Effect.flatMap(Db, (db) => db.execute(sql`SELECT pg_advisory_xact_lock(${catalogLock})`)),
      effect,
    ),
  );

// A version is the hash of its entries, so a cached catalog never goes stale; only the most recent few are kept.
const cache = new Map<string, Catalog>();
const cacheCapacity = 4;

const loadCatalog = Effect.fn("Valuation.loadCatalog")(function* (version: string) {
  const cached = cache.get(version);
  if (cached !== undefined) return cached;
  const db = yield* Db;
  const [row] = yield* db
    .select({ entries: pricingCatalogs.entries })
    .from(pricingCatalogs)
    .where(eq(pricingCatalogs.version, version));
  if (row === undefined) return yield* Effect.die(`pricing catalog ${version} disappeared`);
  const catalog = makeCatalog(decodeEntries(row.entries));
  cache.set(version, catalog);
  for (const stale of [...cache.keys()].slice(0, -cacheCapacity)) cache.delete(stale);
  return catalog;
});

export const ensureBundledCatalog = Effect.fn("Valuation.ensureBundledCatalog")(function* () {
  const db = yield* Db;
  const existing = yield* db
    .select({ version: pricingCatalogs.version })
    .from(pricingCatalogs)
    .where(eq(pricingCatalogs.active, true))
    .limit(1);
  if (existing.length > 0) return existing[0]?.version;
  const version = catalogVersion(bundledEntries);
  yield* db
    .insert(pricingCatalogs)
    .values({ version, source: "bundled", entries: bundledEntries, active: true })
    .onConflictDoUpdate({ target: pricingCatalogs.version, set: { active: true } });
  return version;
});

// recomputeFrom is carried as text: JS dates drop the microseconds Postgres compares against.
const activeState = Effect.fn("Valuation.activeState")(function* () {
  const db = yield* Db;
  const [row] = yield* db
    .select({
      version: pricingCatalogs.version,
      recomputeFrom: sql<string | null>`${pricingCatalogs.recomputeFrom}::text`,
    })
    .from(pricingCatalogs)
    .where(eq(pricingCatalogs.active, true))
    .limit(1);
  if (row === undefined) return yield* Effect.die("no active pricing catalog");
  return { catalog: yield* loadCatalog(row.version), recomputeFrom: row.recomputeFrom };
});

export const activeCatalog = Effect.fn("Valuation.activeCatalog")(function* () {
  return (yield* activeState()).catalog;
});

export const listCatalogs = Effect.fn("Valuation.listCatalogs")(function* () {
  const db = yield* Db;
  const rows = yield* db.select().from(pricingCatalogs).orderBy(desc(pricingCatalogs.fetchedAt));
  return rows.map((row): PricingCatalogView => {
    const entries = decodeEntries(row.entries);
    return {
      version: row.version,
      source: row.source,
      fetchedAt: row.fetchedAt.toISOString(),
      active: row.active,
      pending: row.pending,
      entries: Object.keys(entries.primary).length,
      rules: Object.keys(entries.rules ?? {}).length,
    };
  });
});

const pendingCatalog = Effect.fn("Valuation.pendingCatalog")(function* () {
  const db = yield* Db;
  const [row] = yield* db
    .select({ version: pricingCatalogs.version })
    .from(pricingCatalogs)
    .where(eq(pricingCatalogs.pending, true))
    .limit(1);
  return row === undefined ? null : yield* loadCatalog(row.version);
});

// A row written by older pricing code counts as missing, so the worker reprices it after a pricingVersion bump.
const unvaluedWhere = (db: Db["Service"], condition: SQL | undefined, limit: number) =>
  db
    .select()
    .from(modelRequests)
    .where(
      notExists(
        db
          .select({ one: sql`1` })
          .from(valuations)
          .where(
            and(
              eq(valuations.requestId, modelRequests.id),
              eq(valuations.pricingVersion, pricingVersion),
              condition,
            ),
          ),
      ),
    )
    .limit(limit);

const unvaluedFor = (db: Db["Service"], version: string, limit: number) =>
  unvaluedWhere(db, eq(valuations.catalogVersion, version), limit);

// Rows for the live catalog are exactly the active rows, so the check runs on the small partial index the
// worker polls every pass. A requested recompute also counts rows priced before it as missing.
const unvaluedActive = (db: Db["Service"], limit: number, recomputeFrom: string | null) =>
  unvaluedWhere(
    db,
    and(
      eq(valuations.active, true),
      recomputeFrom === null
        ? undefined
        : sql`${valuations.computedAt} >= ${recomputeFrom}::timestamptz`,
    ),
    limit,
  );

// Turns take the model of their first request, so they follow whenever a request is regrouped.
const refreshPrimaryModels = Effect.fn("Valuation.refreshPrimaryModels")(function* (
  conversationIds: ReadonlyArray<string>,
) {
  if (conversationIds.length === 0) return;
  const db = yield* Db;
  yield* db.execute(sql`
        UPDATE ${conversationTurns} AS t SET primary_model_id = first.model_id
        FROM (
          SELECT DISTINCT ON (conversation_id, turn_index) conversation_id, turn_index, model_id
          FROM ${modelRequests}
          WHERE turn_index IS NOT NULL AND conversation_id IN (${uuidValues(conversationIds)})
          ORDER BY conversation_id, turn_index, requested_at
        ) AS first
        WHERE t.conversation_id = first.conversation_id AND t.turn_index = first.turn_index AND t.primary_model_id IS DISTINCT FROM first.model_id`);
});

// Grouping follows the live catalog only; a pending catalog regroups everything at the moment it takes over.
const regroupAll = Effect.fn("Valuation.regroupAll")(function* (catalog: Catalog) {
  const db = yield* Db;
  const pairs = yield* db
    .selectDistinct({
      modelRaw: modelRequests.modelRaw,
      routeHint: modelRequests.routeHint,
      modelId: modelRequests.modelId,
    })
    .from(modelRequests);
  const touched = new Set<string>();
  for (const pair of pairs) {
    const modelId = resolveModel(catalog, pair.modelRaw, pair.routeHint).modelId;
    if (modelId === pair.modelId) continue;
    const rows = yield* db
      .update(modelRequests)
      .set({ modelId })
      .where(
        and(
          eq(modelRequests.modelRaw, pair.modelRaw),
          sql`${modelRequests.routeHint} IS NOT DISTINCT FROM ${pair.routeHint}`,
          eq(modelRequests.modelId, pair.modelId),
        ),
      )
      .returning({ conversationId: modelRequests.conversationId });
    for (const row of rows) touched.add(row.conversationId);
  }
  yield* refreshPrimaryModels([...touched]);
});

const valueRows = Effect.fn("Valuation.valueRows")(function* (
  catalog: Catalog,
  pending: ReadonlyArray<typeof modelRequests.$inferSelect>,
  active: boolean,
) {
  const regrouped = active
    ? pending.flatMap((request) => {
        const modelId = resolveModel(catalog, request.modelRaw, request.routeHint).modelId;
        return modelId === request.modelId ? [] : [{ id: request.id, modelId }];
      })
    : [];
  const rows = pending.map((request) => {
    const valuation = priceRequest(catalog, {
      modelRaw: request.modelRaw,
      usage: {
        inputTokens: request.inputTokens,
        cacheReadTokens: request.cacheReadTokens,
        cacheWriteTokens: request.cacheWriteTokens,
        cacheWrite1hTokens: request.cacheWrite1hTokens,
        outputTokens: request.outputTokens,
        reasoningTokens: request.reasoningTokens,
      },
      speed: request.speed ?? undefined,
    });
    return valuation.kind === "priced"
      ? {
          requestId: request.id,
          catalogVersion: catalog.version,
          priceKey: valuation.priceKey,
          costUsd: valuation.costUsd.toFixed(10),
          unpricedReason: null,
          breakdown: valuation.breakdown,
          active,
          pricingVersion,
        }
      : {
          requestId: request.id,
          catalogVersion: catalog.version,
          priceKey: valuation.priceKey,
          costUsd: null,
          unpricedReason: valuation.reason,
          breakdown: null,
          active,
          pricingVersion,
        };
  });
  yield* inTransaction(
    Effect.gen(function* () {
      const tx = yield* Db;
      for (const change of regrouped) {
        yield* tx
          .update(modelRequests)
          .set({ modelId: change.modelId })
          .where(eq(modelRequests.id, change.id));
      }
      const regroupedIds = new Set(regrouped.map((change) => change.id));
      yield* refreshPrimaryModels([
        ...new Set(
          pending.flatMap((request) =>
            regroupedIds.has(request.id) ? [request.conversationId] : [],
          ),
        ),
      ]);
      if (active) {
        yield* tx
          .update(valuations)
          .set({ active: false })
          .where(
            and(
              eq(valuations.active, true),
              sql`${valuations.requestId} IN (${uuidValues(rows.map((row) => row.requestId))})`,
            ),
          );
      }
      yield* tx
        .insert(valuations)
        .values(rows)
        .onConflictDoUpdate({
          target: [valuations.requestId, valuations.catalogVersion],
          set: {
            active,
            ...excluded(valuations, [
              "costUsd",
              "priceKey",
              "unpricedReason",
              "breakdown",
              "pricingVersion",
            ]),
            computedAt: sql`now()`,
          },
        });
    }),
  );
  return rows.length;
});

// A pending catalog is priced beside the active one and swapped in only once every request has a row for
// it, so the dashboard never shows a half-repriced archive. The swap re-checks under the lock that the version
// is still pending and fully priced: another activation may have replaced it, or re-activated it and deleted
// its rows, while the last pass ran.
const swapToPending = Effect.fn("Valuation.swapToPending")(function* (catalog: Catalog) {
  const db = yield* Db;
  const { version } = catalog;
  const [still] = yield* db
    .select({ version: pricingCatalogs.version })
    .from(pricingCatalogs)
    .where(and(eq(pricingCatalogs.version, version), eq(pricingCatalogs.pending, true)));
  if (still === undefined || (yield* unvaluedFor(db, version, 1)).length > 0) return;
  yield* db.execute(
    sql`UPDATE ${valuations} SET active = (catalog_version = ${version}) WHERE active <> (catalog_version = ${version})`,
  );
  yield* db.update(pricingCatalogs).set({ active: false, pending: false, recomputeFrom: null });
  yield* db
    .update(pricingCatalogs)
    .set({ active: true })
    .where(eq(pricingCatalogs.version, version));
  yield* regroupAll(catalog);
}, inCatalogTransaction);

// The request inspector shows prices under earlier catalogs, so the few most recent superseded catalogs keep
// their rows. Older ones are dropped: every refresh would otherwise add a row per request forever.
const retainedCatalogs = 3;

export const pruneValuations = Effect.fn("Valuation.prune")(function* () {
  const db = yield* Db;
  const [pruned] = yield* db.execute<{ count: number }>(
    sql`
    WITH stale AS (
      SELECT version FROM ${pricingCatalogs}
      WHERE NOT active AND NOT pending
      ORDER BY fetched_at DESC
      OFFSET ${retainedCatalogs}
    ), deleted AS (
      DELETE FROM ${valuations} WHERE catalog_version IN (SELECT version FROM stale) RETURNING 1
    )
    SELECT count(*)::int AS count FROM deleted`,
    "objects",
  );
  return pruned?.count ?? 0;
});

export const hasCatalogWork = Effect.fn("Valuation.hasCatalogWork")(function* () {
  const db = yield* Db;
  const due = yield* db
    .select({ one: sql`1` })
    .from(pricingCatalogs)
    .where(or(eq(pricingCatalogs.pending, true), isNotNull(pricingCatalogs.recomputeFrom)))
    .limit(1);
  return due.length > 0;
});

const usedModels = Effect.fn("Valuation.usedModels")(function* () {
  const db = yield* Db;
  const rows = yield* db.selectDistinct({ modelRaw: modelRequests.modelRaw }).from(modelRequests);
  return rows.map((row) => row.modelRaw);
});

// A request whose model the pending catalog prices exactly like the live one keeps a live valuation written by
// the running pricing code, so only the repriced models are left to price. The copy runs in the worker so no
// normalization can rewrite a request between reading and copying its row, and without the statement timeout
// because it spans the archive.
const carryOverValuations = Effect.fn("Valuation.carryOverValuations")(function* (
  live: Catalog,
  next: Catalog,
  recomputeFrom: string | null,
) {
  const models = yield* usedModels();
  const repriced = new Set(repricedModels(live, next, models));
  const unchanged = models.filter((model) => !repriced.has(model));
  if (unchanged.length === 0) return;
  yield* inTransaction(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.execute(sql`SET LOCAL statement_timeout = 0`);
      yield* db
        .insert(valuations)
        .select(
          db
            .select({
              requestId: valuations.requestId,
              catalogVersion: sql<string>`${next.version}::text`.as("catalog_version"),
              priceKey: valuations.priceKey,
              costUsd: valuations.costUsd,
              unpricedReason: valuations.unpricedReason,
              breakdown: valuations.breakdown,
              computedAt: valuations.computedAt,
              active: sql<boolean>`false`.as("active"),
              pricingVersion: valuations.pricingVersion,
            })
            .from(valuations)
            .innerJoin(modelRequests, eq(modelRequests.id, valuations.requestId))
            .where(
              and(
                eq(valuations.catalogVersion, live.version),
                eq(valuations.pricingVersion, pricingVersion),
                sql`${modelRequests.modelRaw} IN (${textValues(unchanged)})`,
                recomputeFrom === null
                  ? undefined
                  : sql`${valuations.computedAt} >= ${recomputeFrom}::timestamptz`,
              ),
            ),
        )
        .onConflictDoNothing();
    }),
  );
});

export const valuePending = Effect.fn("Valuation.valuePending")(function* (limit: number) {
  const db = yield* Db;
  const { catalog, recomputeFrom } = yield* activeState();
  const pending = yield* unvaluedActive(db, limit, recomputeFrom);
  let valued = pending.length === 0 ? 0 : yield* valueRows(catalog, pending, true);
  if (recomputeFrom !== null && (yield* unvaluedActive(db, 1, recomputeFrom)).length === 0) {
    yield* db
      .update(pricingCatalogs)
      .set({ recomputeFrom: null })
      .where(
        and(
          eq(pricingCatalogs.version, catalog.version),
          sql`${pricingCatalogs.recomputeFrom} = ${recomputeFrom}::timestamptz`,
        ),
      );
  }
  const next = yield* pendingCatalog();
  if (next !== null) {
    yield* carryOverValuations(catalog, next, recomputeFrom);
    const waiting = yield* unvaluedFor(db, next.version, limit);
    if (waiting.length > 0) valued += yield* valueRows(next, waiting, false);
    const remaining = yield* unvaluedFor(db, next.version, 1);
    if (remaining.length === 0) {
      yield* swapToPending(next);
      yield* pruneValuations();
    }
  }
  return valued;
});

export const repricingProgress = Effect.fn("Valuation.repricingProgress")(function* () {
  const db = yield* Db;
  const next = yield* pendingCatalog();
  if (next === null) return null;
  const [done] = yield* db
    .select({ n: count() })
    .from(valuations)
    .where(eq(valuations.catalogVersion, next.version));
  const [total] = yield* db.select({ n: count() }).from(modelRequests);
  return {
    version: next.version,
    done: number(done?.n),
    total: number(total?.n),
  } satisfies Repricing;
});

// Activating the version that is already live recalculates it in place, keeping the current prices visible
// until each request is repriced; any other version becomes pending and takes over once the worker has priced
// every request with it.
export const activateCatalog = Effect.fn("Valuation.activateCatalog")(function* (version: string) {
  const db = yield* Db;
  const found = yield* db
    .select({ version: pricingCatalogs.version, active: pricingCatalogs.active })
    .from(pricingCatalogs)
    .where(eq(pricingCatalogs.version, version))
    .limit(1);
  const row = found[0];
  if (row === undefined) return yield* new NotFound({ entity: "catalog", id: version });
  yield* db.update(pricingCatalogs).set({ pending: false });
  if (row.active) {
    yield* db
      .update(pricingCatalogs)
      .set({ recomputeFrom: sql`now()` })
      .where(eq(pricingCatalogs.version, version));
    return;
  }
  yield* db
    .update(pricingCatalogs)
    .set({ pending: true })
    .where(eq(pricingCatalogs.version, version));
  yield* db.delete(valuations).where(eq(valuations.catalogVersion, version));
}, inCatalogTransaction);

// Reprocessing rebuilds every request, so the live catalog recalculates in place and a pending catalog starts
// pricing again instead of being dropped.
export const recalculateCatalogs = Effect.fn("Valuation.recalculateCatalogs")(function* () {
  const active = yield* activeCatalog();
  const pending = yield* pendingCatalog();
  yield* activateCatalog(active.version);
  if (pending !== null) yield* activateCatalog(pending.version);
  return active.version;
}, inCatalogTransaction);

const loadRules = Effect.fn("Valuation.loadRules")(function* () {
  const db = yield* Db;
  const rows = yield* db.select().from(pricingRules).orderBy(pricingRules.model);
  return rows;
});

const rulesRecord = (rows: ReadonlyArray<typeof pricingRules.$inferSelect>): PricingRules =>
  Object.fromEntries(rows.map((row) => [row.model, row.rule]));

const ruleView = (row: typeof pricingRules.$inferSelect): PricingRuleView => ({
  model: row.model,
  rule: row.rule,
  updatedAt: row.updatedAt.toISOString(),
});

export const listRules = Effect.fn("Valuation.listRules")(function* () {
  return (yield* loadRules()).map(ruleView);
});

// Rule edits become a new catalog version, so the normal revalue path reprices. They build on a pending
// catalog when there is one, so a rule saved during a refresh does not discard the refreshed rates.
const materializeRules = Effect.fn("Valuation.materializeRules")(function* () {
  const db = yield* Db;
  const current = (yield* pendingCatalog()) ?? (yield* activeCatalog());
  const entries = withRules(current.entries, rulesRecord(yield* loadRules()));
  const version = catalogVersion(entries);
  if (version === current.version) return;
  yield* db
    .insert(pricingCatalogs)
    .values({ version, source: "rules", entries, active: false })
    .onConflictDoNothing();
  yield* activateCatalog(version).pipe(Effect.catchTag("NotFound", Effect.die));
});

export const upsertRule = Effect.fn("Valuation.upsertRule")(function* (
  modelRaw: string,
  rule: PricingRule,
) {
  const db = yield* Db;
  const model = ruleKey(modelRaw);
  if (model === "") return yield* new BadRequest({ message: "A rule needs a model name." });
  if (rule.kind === "alias") {
    const target = ruleKey(rule.target);
    if (target === "" || target === model)
      return yield* new BadRequest({ message: "An alias needs a different target model." });
    const existing = rulesRecord(yield* loadRules());
    if (existing[target]?.kind === "alias")
      return yield* new BadRequest({
        message: `${target} is itself an alias; point at its target instead.`,
      });
    if (
      Object.values(existing).some(
        (other) => other.kind === "alias" && ruleKey(other.target) === model,
      )
    ) {
      return yield* new BadRequest({
        message: `${model} is already an alias target and cannot become an alias.`,
      });
    }
  }
  const [row] = yield* db
    .insert(pricingRules)
    .values({ model, rule })
    .onConflictDoUpdate({ target: pricingRules.model, set: { rule, updatedAt: sql`now()` } })
    .returning();
  if (row === undefined) return yield* Effect.die("rule upsert returned no row");
  yield* materializeRules();
  return ruleView(row);
}, inCatalogTransaction);

export const deleteRule = Effect.fn("Valuation.deleteRule")(function* (modelRaw: string) {
  const db = yield* Db;
  const model = ruleKey(modelRaw);
  const rows = yield* db
    .delete(pricingRules)
    .where(eq(pricingRules.model, model))
    .returning({ model: pricingRules.model });
  if (rows.length === 0) return yield* new NotFound({ entity: "rule", id: model });
  yield* materializeRules();
}, inCatalogTransaction);

export const listUnpricedModels = Effect.fn("Valuation.listUnpricedModels")(function* () {
  const db = yield* Db;
  const rows = yield* db
    .select({
      modelRaw: modelRequests.modelRaw,
      modelId: modelRequests.modelId,
      provider: modelRequests.provider,
      requests: count(),
      reason: min(valuations.unpricedReason),
      lastSeenAt: sql<Date>`max(${modelRequests.requestedAt})`,
    })
    .from(modelRequests)
    .innerJoin(
      valuations,
      and(
        eq(valuations.requestId, modelRequests.id),
        eq(valuations.active, true),
        isNull(valuations.costUsd),
      ),
    )
    .groupBy(modelRequests.modelRaw, modelRequests.modelId, modelRequests.provider)
    .orderBy(desc(sql`count(*)`))
    .limit(200);
  return rows.map((row): UnpricedModelRow => ({
    modelRaw: row.modelRaw,
    modelId: row.modelId,
    provider: row.provider,
    requests: number(row.requests),
    reason: row.reason,
    lastSeenAt: new Date(row.lastSeenAt).toISOString(),
  }));
});

const upstreamEntries = Effect.fn("Valuation.upstreamEntries")(function* (
  current: Catalog,
  document: LiteLLMDocument,
) {
  return withRules(refreshedEntries(current.entries, document), rulesRecord(yield* loadRules()));
});

const stageUpstream = Effect.fn("Valuation.stageUpstream")(function* (entries: CatalogEntries) {
  const db = yield* Db;
  const version = catalogVersion(entries);
  yield* db
    .insert(pricingCatalogs)
    .values({ version, source: "litellm", entries, active: false })
    .onConflictDoNothing();
  yield* activateCatalog(version).pipe(Effect.catchTag("NotFound", Effect.die));
  return version;
});

export const refreshPricing = Effect.fn("Valuation.refreshPricing")(function* () {
  const document = yield* fetchLiteLLM();
  const version = yield* inCatalogTransaction(
    Effect.gen(function* () {
      return yield* stageUpstream(yield* upstreamEntries(yield* activeCatalog(), document));
    }),
  );
  const views = yield* listCatalogs();
  const view = views.find((candidate) => candidate.version === version);
  return view === undefined ? yield* Effect.die("refreshed catalog missing") : view;
});

// LiteLLM edits rows nobody here uses almost daily and every adopted catalog still writes a valuation per
// request, so the scheduled refresh adopts upstream only when it reprices a model the archive contains, and
// never replaces a repricing that is still running.
export const autoRefreshPricing = Effect.fn("Valuation.autoRefreshPricing")(function* () {
  const document = yield* fetchLiteLLM().pipe(Effect.timeout("2 minutes"));
  const models = yield* usedModels();
  return yield* inCatalogTransaction(
    Effect.gen(function* () {
      if ((yield* pendingCatalog()) !== null) return [];
      const current = yield* activeCatalog();
      const entries = yield* upstreamEntries(current, document);
      const repriced = repricedModels(current, makeCatalog(entries), models);
      if (repriced.length > 0) yield* stageUpstream(entries);
      return repriced;
    }),
  );
});

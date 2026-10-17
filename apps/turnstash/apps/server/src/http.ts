import { Api, BadRequest, CurrentActor } from "@aqt/turnstash-api";
import { count, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import {
  changePlan,
  createPlan,
  createToken,
  deletePlan,
  deleteToken,
  enrollMachine,
  listPlans,
  listTokens,
  updatePlan,
} from "./admin.ts";
import { computeAnalysis } from "./analysis.ts";
import { createBookmark, deleteBookmark, listBookmarks, updateBookmark } from "./bookmarks.ts";
import { serverVersion } from "./config.ts";
import {
  deleteConversation,
  getConversation,
  getMessages,
  getRequest,
  listConversations,
} from "./conversations.ts";
import { Db } from "./db/client.ts";
import { dirtyConversations, pricingCatalogs } from "./db/schema.ts";
import { applyCommitBatch, repositoryTasks } from "./git.ts";
import { databaseFailure } from "./http-errors.ts";
import { applyBatch, tombstonesSince } from "./ingest.ts";
import { exportMarkdown } from "./markdown-export.ts";
import { search } from "./search.ts";
import {
  computeStats,
  dailyStats,
  machineDetail,
  machineSummaries,
  overallStats,
  projectDetail,
  projectRows,
} from "./stats.ts";
import {
  activateCatalog,
  deleteRule,
  listCatalogs,
  listRules,
  listUnpricedModels,
  refreshPricing,
  repricingProgress,
  upsertRule,
} from "./valuation.ts";

const machineActor = Effect.gen(function* () {
  const actor = yield* CurrentActor;
  if (actor.kind !== "machine")
    return yield* new BadRequest({ message: "ingest requires a machine token" });
  return actor;
});

const ownMachine = (machineId: string) =>
  Effect.gen(function* () {
    const actor = yield* machineActor;
    if (actor.machineId !== machineId)
      return yield* new BadRequest({ message: "machineId does not match the token" });
    return actor;
  });

const SystemLive = HttpApiBuilder.group(Api, "system", (handlers) =>
  handlers.handle("health", () =>
    Effect.gen(function* () {
      const db = yield* Db;
      const [dirty] = yield* db.select({ n: count() }).from(dirtyConversations);
      const [catalog] = yield* db
        .select({ version: pricingCatalogs.version })
        .from(pricingCatalogs)
        .where(eq(pricingCatalogs.active, true))
        .limit(1);
      const repricing = yield* repricingProgress();
      return {
        ok: true,
        version: serverVersion,
        dirtyConversations: dirty?.n ?? 0,
        activeCatalog: catalog?.version ?? null,
        repricing,
      };
    }).pipe(databaseFailure),
  ),
);

const IngestLive = HttpApiBuilder.group(Api, "ingest", (handlers) =>
  handlers
    .handle("pushBatch", ({ payload }) =>
      ownMachine(payload.machineId).pipe(
        Effect.flatMap((actor) => applyBatch(actor.machineId, payload)),
        databaseFailure,
      ),
    )
    .handle("tombstones", ({ query }) => tombstonesSince(query.since).pipe(databaseFailure))
    .handle("repositories", () =>
      machineActor.pipe(
        Effect.flatMap((actor) => repositoryTasks(actor.machineId)),
        databaseFailure,
      ),
    )
    .handle("pushCommits", ({ payload }) =>
      ownMachine(payload.machineId).pipe(
        Effect.flatMap((actor) => applyCommitBatch(actor.machineId, payload)),
        databaseFailure,
      ),
    ),
);

const ReadLive = HttpApiBuilder.group(Api, "read", (handlers) =>
  handlers
    .handle("listBookmarks", ({ query }) => listBookmarks(query).pipe(databaseFailure))
    .handle("exportMarkdown", ({ params, payload }) =>
      exportMarkdown(params.id, payload).pipe(databaseFailure),
    )
    .handle("stats", ({ query }) => computeStats(query).pipe(databaseFailure))
    .handle("statsOverall", ({ query }) => overallStats(query).pipe(databaseFailure))
    .handle("statsDaily", ({ query }) => dailyStats(query).pipe(databaseFailure))
    .handle("analysis", ({ query }) => computeAnalysis(query).pipe(databaseFailure))
    .handle("listConversations", ({ query }) => listConversations(query).pipe(databaseFailure))
    .handle("getConversation", ({ params }) => getConversation(params.id).pipe(databaseFailure))
    .handle("getMessages", ({ params, query }) =>
      getMessages(params.id, query.cursor, query.limit ?? 200, query).pipe(databaseFailure),
    )
    .handle("getRequest", ({ params }) => getRequest(params.id).pipe(databaseFailure))
    .handle("search", ({ query }) => search(query).pipe(databaseFailure))
    .handle("listMachines", () => machineSummaries({}).pipe(databaseFailure))
    .handle("getMachine", ({ params, query }) =>
      machineDetail(params.id, query).pipe(databaseFailure),
    )
    .handle("listProjects", ({ query }) => projectRows(query).pipe(databaseFailure))
    .handle("getProject", ({ params, query }) =>
      projectDetail(params.key, query).pipe(databaseFailure),
    )
    .handle("listPlans", () => listPlans().pipe(databaseFailure)),
);

const AdminLive = HttpApiBuilder.group(Api, "admin", (handlers) =>
  handlers
    .handle("createBookmark", ({ payload }) => createBookmark(payload).pipe(databaseFailure))
    .handle("updateBookmark", ({ params, payload }) =>
      updateBookmark(params.id, payload.note).pipe(databaseFailure),
    )
    .handle("deleteBookmark", ({ params }) => deleteBookmark(params.id).pipe(databaseFailure))
    .handle("enroll", ({ payload }) => enrollMachine(payload).pipe(databaseFailure))
    .handle("deleteConversation", ({ params }) =>
      deleteConversation(params.id).pipe(databaseFailure),
    )
    .handle("createPlan", ({ payload }) => createPlan(payload).pipe(databaseFailure))
    .handle("updatePlan", ({ params, payload }) =>
      updatePlan(params.id, payload).pipe(databaseFailure),
    )
    .handle("changePlan", ({ params, payload }) =>
      changePlan(params.id, payload).pipe(databaseFailure),
    )
    .handle("deletePlan", ({ params }) => deletePlan(params.id).pipe(databaseFailure))
    .handle("listCatalogs", () => listCatalogs().pipe(databaseFailure))
    .handle("refreshPricing", () =>
      refreshPricing().pipe(
        Effect.catchTag(
          "HttpClientError",
          (error) => new BadRequest({ message: `LiteLLM fetch failed: ${error.message}` }),
        ),
        Effect.catchTag(
          "SchemaError",
          (error) => new BadRequest({ message: `LiteLLM document invalid: ${error.message}` }),
        ),
        databaseFailure,
      ),
    )
    .handle("revalue", ({ payload }) =>
      activateCatalog(payload.catalogVersion).pipe(Effect.as({ queued: true }), databaseFailure),
    )
    .handle("listRules", () => listRules().pipe(databaseFailure))
    .handle("upsertRule", ({ payload }) =>
      upsertRule(payload.model, payload.rule).pipe(databaseFailure),
    )
    .handle("deleteRule", ({ query }) => deleteRule(query.model).pipe(databaseFailure))
    .handle("listUnpricedModels", () => listUnpricedModels().pipe(databaseFailure))
    .handle("listTokens", () => listTokens().pipe(databaseFailure))
    .handle("createToken", ({ payload }) =>
      createToken(payload.name, payload.scopes).pipe(databaseFailure),
    )
    .handle("deleteToken", ({ params }) => deleteToken(params.id).pipe(databaseFailure)),
);

export const ApiLive = HttpApiBuilder.layer(Api, { openapiPath: "/api/openapi.json" }).pipe(
  Layer.provide(Layer.mergeAll(SystemLive, IngestLive, ReadLive, AdminLive)),
);

import {
  type ApiTokenCreated,
  type ApiTokenView,
  NotFound,
  PlanEndsBeforeStart,
  PlanOverlap,
  type SubscriptionPlan,
  type SubscriptionPlanChange,
  type SubscriptionPlanInput,
  type SubscriptionPlanPatch,
  type TokenScope,
} from "@aqt/turnstash-api";
import { type EnrollRequest, type EnrollResponse, MachineId, sha256Hex } from "@aqt/turnstash-core";
import { and, desc, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import { Effect } from "effect";

import { newSecret } from "./auth.ts";
import { Db, inTransaction } from "./db/client.ts";
import { apiTokens, machines, subscriptionPlans } from "./db/schema.ts";
import { number } from "./filters.ts";

export const enrollMachine = Effect.fn("Admin.enroll")(function* (request: EnrollRequest) {
  const db = yield* Db;
  const token = newSecret();
  const [row] = yield* db
    .insert(machines)
    .values({
      name: request.name,
      os: request.os,
      arch: request.arch,
      agentVersion: request.agentVersion,
      tokenHash: sha256Hex(token),
    })
    .returning({ id: machines.id });
  if (row === undefined) return yield* Effect.die("enroll returned no row");
  return { machineId: MachineId.make(row.id), token } satisfies EnrollResponse;
});

type PlanRow = typeof subscriptionPlans.$inferSelect;

const planView = (row: PlanRow): SubscriptionPlan => ({
  id: row.id,
  provider: row.provider,
  name: row.name,
  monthlyPrice: number(row.monthlyPrice),
  currency: row.currency,
  startedOn: row.startedOn,
  endedOn: row.endedOn,
});

// Writers queue behind one another so two saves cannot both pass the overlap check; reads are not blocked.
const lockPlans = Effect.flatMap(Db, (db) =>
  db.execute(sql`LOCK TABLE ${subscriptionPlans} IN SHARE ROW EXCLUSIVE MODE`),
);

// Runs after the write, inside its transaction, so a refusal rolls the write back.
const validPlanView = Effect.fn("Admin.validatePlan")(function* (row: PlanRow) {
  if (row.endedOn !== null && row.endedOn < row.startedOn)
    return yield* new PlanEndsBeforeStart({ startedOn: row.startedOn, endedOn: row.endedOn });
  const db = yield* Db;
  const [existing] = yield* db
    .select()
    .from(subscriptionPlans)
    .where(
      and(
        eq(subscriptionPlans.provider, row.provider),
        ne(subscriptionPlans.id, row.id),
        row.endedOn === null ? undefined : lte(subscriptionPlans.startedOn, row.endedOn),
        or(isNull(subscriptionPlans.endedOn), gte(subscriptionPlans.endedOn, row.startedOn)),
      ),
    )
    .orderBy(subscriptionPlans.startedOn)
    .limit(1);
  if (existing !== undefined) return yield* new PlanOverlap({ existing: planView(existing) });
  return planView(row);
});

export const listPlans = Effect.fn("Admin.listPlans")(function* () {
  const db = yield* Db;
  const rows = yield* db
    .select()
    .from(subscriptionPlans)
    .orderBy(desc(subscriptionPlans.startedOn));
  return rows.map(planView);
});

const insertPlan = Effect.fn("Admin.insertPlan")(function* (input: SubscriptionPlanInput) {
  const db = yield* Db;
  const [row] = yield* db
    .insert(subscriptionPlans)
    .values({
      provider: input.provider,
      name: input.name,
      monthlyPrice: input.monthlyPrice.toFixed(2),
      currency: input.currency ?? "USD",
      startedOn: input.startedOn,
      endedOn: input.endedOn ?? null,
    })
    .returning();
  if (row === undefined) return yield* Effect.die("plan insert returned no row");
  return yield* validPlanView(row);
});

const patchPlan = Effect.fn("Admin.patchPlan")(function* (
  id: string,
  patch: SubscriptionPlanPatch,
) {
  const db = yield* Db;
  const [row] = yield* db
    .update(subscriptionPlans)
    .set({
      ...(patch.provider === undefined ? {} : { provider: patch.provider }),
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.monthlyPrice === undefined ? {} : { monthlyPrice: patch.monthlyPrice.toFixed(2) }),
      ...(patch.currency === undefined ? {} : { currency: patch.currency }),
      ...(patch.startedOn === undefined ? {} : { startedOn: patch.startedOn }),
      ...(patch.endedOn === undefined ? {} : { endedOn: patch.endedOn }),
    })
    .where(eq(subscriptionPlans.id, id))
    .returning();
  if (row === undefined) return yield* new NotFound({ entity: "plan", id });
  return yield* validPlanView(row);
});

export const createPlan = Effect.fn("Admin.createPlan")(function* (input: SubscriptionPlanInput) {
  yield* lockPlans;
  return yield* insertPlan(input);
}, inTransaction);

export const updatePlan = Effect.fn("Admin.updatePlan")(function* (
  id: string,
  patch: SubscriptionPlanPatch,
) {
  yield* lockPlans;
  return yield* patchPlan(id, patch);
}, inTransaction);

const dayBefore = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export const changePlan = Effect.fn("Admin.changePlan")(function* (
  id: string,
  change: SubscriptionPlanChange,
) {
  yield* lockPlans;
  const db = yield* Db;
  const [current] = yield* db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, id));
  if (current === undefined) return yield* new NotFound({ entity: "plan", id });
  yield* patchPlan(id, { endedOn: dayBefore(change.effectiveOn) });
  return yield* insertPlan({
    provider: current.provider,
    name: change.name,
    monthlyPrice: change.monthlyPrice,
    currency: change.currency ?? current.currency,
    startedOn: change.effectiveOn,
    endedOn: current.endedOn,
  });
}, inTransaction);

export const deletePlan = Effect.fn("Admin.deletePlan")(function* (id: string) {
  const db = yield* Db;
  const rows = yield* db
    .delete(subscriptionPlans)
    .where(eq(subscriptionPlans.id, id))
    .returning({ id: subscriptionPlans.id });
  if (rows.length === 0) return yield* new NotFound({ entity: "plan", id });
});

const tokenView = (row: typeof apiTokens.$inferSelect): ApiTokenView => ({
  id: row.id,
  name: row.name,
  scopes: row.scopes,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
});

export const listTokens = Effect.fn("Admin.listTokens")(function* () {
  const db = yield* Db;
  const rows = yield* db.select().from(apiTokens).orderBy(desc(apiTokens.createdAt));
  return rows.map(tokenView);
});

export const createToken = Effect.fn("Admin.createToken")(function* (
  name: string,
  scopes: ReadonlyArray<TokenScope>,
) {
  const db = yield* Db;
  const secret = newSecret();
  const [row] = yield* db
    .insert(apiTokens)
    .values({ name, scopes: [...scopes], tokenHash: sha256Hex(secret) })
    .returning();
  if (row === undefined) return yield* Effect.die("token insert returned no row");
  return { token: tokenView(row), secret } satisfies ApiTokenCreated;
});

export const deleteToken = Effect.fn("Admin.deleteToken")(function* (id: string) {
  const db = yield* Db;
  const rows = yield* db
    .delete(apiTokens)
    .where(eq(apiTokens.id, id))
    .returning({ id: apiTokens.id });
  if (rows.length === 0) return yield* new NotFound({ entity: "token", id });
});

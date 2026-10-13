import { timingSafeEqual } from "node:crypto";

import {
  type Actor,
  AdminAuth,
  CurrentActor,
  MachineAuth,
  ReadAuth,
  type TokenScope,
  Unauthorized,
} from "@aqt/turnstash-api";
import { MachineId, sha256Hex } from "@aqt/turnstash-core";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { type Context, Effect, Layer, Redacted } from "effect";
import type { HttpServerRequest } from "effect/http";

import { ServerConfig } from "./config.ts";
import { authorizeDashboard } from "./dashboard-auth.ts";
import { Db } from "./db/client.ts";
import { apiTokens, machines } from "./db/schema.ts";
import { databaseFailure } from "./http-errors.ts";

export const newSecret = (): string =>
  `cb_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;

const sameToken = (a: string, b: string): boolean =>
  timingSafeEqual(Buffer.from(sha256Hex(a)), Buffer.from(sha256Hex(b)));

const admin: Actor = { kind: "admin" };
const unauthorized = (reason: Unauthorized["reason"]) => new Unauthorized({ reason });

const isAdminToken = Effect.fn("Auth.isAdminToken")(function* (credential: Redacted.Redacted) {
  const { auth } = yield* ServerConfig;
  return (
    auth.mode === "token" && sameToken(Redacted.value(credential), Redacted.value(auth.adminToken))
  );
});

const dashboardActor = (credential: Redacted.Redacted) =>
  authorizeDashboard(Redacted.value(credential)).pipe(Effect.as(admin));

// Last-seen times feed a freshness badge, so a write per minute is enough.
const staleSince = sql`now() - interval '1 minute'`;

const machineActor = Effect.fn("Auth.machineActor")(function* (credential: Redacted.Redacted) {
  const db = yield* Db;
  const [machine] = yield* db
    .select({ id: machines.id, lastSeenAt: machines.lastSeenAt })
    .from(machines)
    .where(eq(machines.tokenHash, sha256Hex(Redacted.value(credential))));
  if (machine === undefined) return yield* unauthorized("invalid");
  yield* db
    .update(machines)
    .set({ lastSeenAt: sql`now()` })
    .where(
      and(
        eq(machines.id, machine.id),
        or(isNull(machines.lastSeenAt), lt(machines.lastSeenAt, staleSince)),
      ),
    );
  return { kind: "machine", machineId: MachineId.make(machine.id) } satisfies Actor;
});

const tokenActor = Effect.fn("Auth.tokenActor")(function* (
  credential: Redacted.Redacted,
  scope: TokenScope,
) {
  if (yield* isAdminToken(credential)) return admin;
  const db = yield* Db;
  const [token] = yield* db
    .select({ id: apiTokens.id, scopes: apiTokens.scopes })
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, sha256Hex(Redacted.value(credential))));
  if (token === undefined) return yield* unauthorized("invalid");
  if (!token.scopes.includes("admin") && !token.scopes.includes(scope))
    return yield* unauthorized("scope");
  yield* db
    .update(apiTokens)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(apiTokens.id, token.id),
        or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, staleSince)),
      ),
    );
  return { kind: "token", tokenId: token.id, scopes: token.scopes } satisfies Actor;
});

// Middleware runs with only the router's request context, so the services the resolver needs are captured at Layer build time.
const secured =
  <R, E>(
    services: Context.Context<R>,
    resolve: (
      credential: Redacted.Redacted,
    ) => Effect.Effect<Actor, E, R | HttpServerRequest.HttpServerRequest>,
  ) =>
  <A, E2>(
    httpEffect: Effect.Effect<A, E2, CurrentActor>,
    { credential }: { readonly credential: Redacted.Redacted },
  ) =>
    Effect.gen(function* () {
      if (Redacted.value(credential) === "") return yield* unauthorized("missing");
      return yield* resolve(credential);
    }).pipe(
      Effect.flatMap((actor) => Effect.provideService(httpEffect, CurrentActor, actor)),
      databaseFailure,
      Effect.provideContext(services),
    );

export const AdminAuthLive = Layer.effect(
  AdminAuth,
  Effect.gen(function* () {
    const services = yield* Effect.context<Db | ServerConfig>();
    return AdminAuth.of({
      session: secured(services, dashboardActor),
      bearer: secured(services, (credential) => tokenActor(credential, "admin")),
    });
  }),
);

export const ReadAuthLive = Layer.effect(
  ReadAuth,
  Effect.gen(function* () {
    const services = yield* Effect.context<Db | ServerConfig>();
    return ReadAuth.of({
      session: secured(services, dashboardActor),
      bearer: secured(services, (credential) => tokenActor(credential, "read")),
    });
  }),
);

export const MachineAuthLive = Layer.effect(
  MachineAuth,
  Effect.gen(function* () {
    const services = yield* Effect.context<Db>();
    return MachineAuth.of({ bearer: secured(services, machineActor) });
  }),
);

export const AuthLive = Layer.mergeAll(AdminAuthLive, ReadAuthLive, MachineAuthLive);

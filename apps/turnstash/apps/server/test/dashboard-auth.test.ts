import { expect, test } from "bun:test";

import { dashboardCookie } from "@aqt/turnstash-api";
import { EnrollResponse, sha256Hex } from "@aqt/turnstash-core";
import { BunHttpClient, BunHttpServer } from "@effect/platform-bun";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter } from "effect/http";

import { AuthLive } from "../src/auth.ts";
import { type OidcAuth, ServerConfig } from "../src/config.ts";
import { DashboardRoutes, sealLogin } from "../src/dashboard-auth.ts";
import { Db } from "../src/db/client.ts";
import { dashboardSessions } from "../src/db/schema.ts";
import { ApiLive } from "../src/http.ts";
import { OpenId } from "../src/openid.ts";
import { runTest, type TestServices } from "./support.ts";

const origin = "https://turnstash.test";
const subject = "owner-id";
const identity = { subject, name: "Owner" };
const oidcAuth: OidcAuth = {
  mode: "oidc",
  issuer: "https://auth.test/",
  clientId: "turnstash",
  clientSecret: Redacted.make("secret"),
  origin,
  adminSubject: subject,
};
const loginCookie = "__Host-turnstash-login";
const cookie = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`))
    ?.split(";")[0] ?? "";

const withDashboard = (
  body: (
    request: (path: string, init?: RequestInit) => Promise<Response>,
    db: Context.Context<TestServices>,
  ) => Promise<void>,
) =>
  runTest(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const services = Context.add(yield* Effect.context<TestServices>(), ServerConfig, {
        ...config,
        auth: oidcAuth,
      });
      const provider = Layer.succeed(
        OpenId,
        OpenId.of({
          start: () =>
            Effect.succeed({
              state: "state",
              verifier: "verifier",
              nonce: "nonce",
              url: "https://auth.test/authorize",
            }),
          finish: (url, login) =>
            Effect.sync(() => {
              expect(url.origin).toBe(origin);
              expect(url.searchParams.get("code")).toBe("test-code");
              expect(login).toMatchObject({ state: "state", verifier: "verifier", nonce: "nonce" });
              return identity;
            }),
        }),
      );
      const web = HttpRouter.toWebHandler(
        Layer.mergeAll(ApiLive, DashboardRoutes).pipe(
          Layer.provide(AuthLive),
          Layer.provideMerge(Layer.succeedContext(services)),
          Layer.provideMerge(provider),
          Layer.provideMerge(BunHttpClient.layer),
          Layer.provide(BunHttpServer.layerHttpServices),
        ),
        { disableLogger: true },
      );
      yield* Effect.promise(() =>
        body((path, init) => web.handler(new Request(`${origin}${path}`, init)), services),
      ).pipe(Effect.ensuring(Effect.promise(() => web.dispose())));
    }),
  );

const signIn = async (request: (path: string, init?: RequestInit) => Promise<Response>) => {
  const login = await request("/auth/login");
  expect(login.status).toBe(302);
  const callback = await request("/auth/callback?code=test-code", {
    headers: { cookie: cookie(login, loginCookie), host: "attacker.test" },
  });
  expect(callback.status).toBe(302);
  return { login, callback, session: cookie(callback, dashboardCookie) };
};

test("OIDC login sets a private session and rejects a missing, forged or tampered login cookie", () =>
  withDashboard(async (request) => {
    expect(await (await request("/auth/session")).json()).toEqual({ mode: "oidc", user: null });
    const { login, callback, session } = await signIn(request);
    for (const response of [login, callback]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      expect(response.headers.get("set-cookie")).toContain("Secure");
      expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    }
    expect(
      callback.headers.getSetCookie().some((value) => value.startsWith(`${loginCookie}=;`)),
    ).toBe(true);
    const sealed = cookie(login, loginCookie).slice(`${loginCookie}=`.length);
    // The last base64url character can carry only padding bits, so the change goes into the IV up front.
    const tampered = `${sealed.startsWith("A") ? "B" : "A"}${sealed.slice(1)}`;
    const forged = sealLogin(
      { ...oidcAuth, clientSecret: Redacted.make("another-secret") },
      { state: "state", verifier: "verifier", nonce: "nonce", expiresAt: Date.now() + 60_000 },
    );
    for (const value of [tampered, forged, "not-a-login"])
      expect(
        (
          await request("/auth/callback?code=test-code", {
            headers: { cookie: `${loginCookie}=${value}` },
          })
        ).status,
      ).toBe(401);
    expect((await request("/auth/callback?code=test-code")).status).toBe(401);
    expect(await (await request("/auth/session", { headers: { cookie: session } })).json()).toEqual(
      { mode: "oidc", user: identity },
    );
    expect((await request("/api/stats", { headers: { cookie: session } })).status).toBe(200);
  }));

test("dashboard sessions enroll machines with same-origin requests while agent tokens remain independent", () =>
  withDashboard(async (request) => {
    const { session } = await signIn(request);
    const enrollment = { name: "test-machine", os: "linux", arch: "x64", agentVersion: "test" };
    const enroll = (headers: Record<string, string>) =>
      request("/api/enroll", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(enrollment),
      });
    for (const headers of [
      { cookie: session },
      { cookie: session, origin: "https://attacker.test" },
      { cookie: session, origin, "sec-fetch-site": "cross-site" },
      { authorization: "Bearer admin-secret", origin },
    ])
      expect((await enroll(headers)).status).toBe(401);
    const enrolled = await enroll({ cookie: session, origin });
    expect(enrolled.status).toBe(200);
    const machine = Schema.decodeUnknownSync(EnrollResponse)(await enrolled.json());
    expect(
      (
        await request("/api/ingest/tombstones", {
          headers: { authorization: `Bearer ${machine.token}` },
        })
      ).status,
    ).toBe(200);
    expect((await enroll({ authorization: `Bearer ${machine.token}`, origin })).status).toBe(401);
    expect((await request("/api/ingest/tombstones", { headers: { cookie: session } })).status).toBe(
      401,
    );
    expect(
      (await request("/api/stats", { headers: { authorization: "Bearer admin-secret" } })).status,
    ).toBe(401);
    expect((await request("/api/stats")).status).toBe(401);
  }));

test("logout revokes the session and rejects cross-origin logout", () =>
  withDashboard(async (request) => {
    const { session } = await signIn(request);
    expect(
      (
        await request("/auth/logout", {
          method: "POST",
          headers: { cookie: session, origin: "https://attacker.test" },
        })
      ).status,
    ).toBe(403);
    expect((await request("/api/stats", { headers: { cookie: session } })).status).toBe(200);
    const logout = await request("/auth/logout", {
      method: "POST",
      headers: { cookie: session, origin },
    });
    expect(logout.status).toBe(303);
    expect((await request("/api/stats", { headers: { cookie: session } })).status).toBe(401);
  }));

test("expired login, expired session and a session for a different owner are rejected", () =>
  withDashboard(async (request, services) => {
    const expired = sealLogin(oidcAuth, {
      state: "state",
      verifier: "verifier",
      nonce: "nonce",
      expiresAt: Date.now() - 1,
    });
    expect(
      (
        await request("/auth/callback?code=test-code", {
          headers: { cookie: `${loginCookie}=${expired}` },
        })
      ).status,
    ).toBe(401);
    const { session } = await signIn(request);
    const tokenHash = sha256Hex(session.slice(`${dashboardCookie}=`.length));
    for (const values of [{ subject: "another-owner" }, { subject, expiresAt: new Date(0) }]) {
      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* Db;
          yield* db
            .update(dashboardSessions)
            .set(values)
            .where(eq(dashboardSessions.tokenHash, tokenHash));
        }).pipe(Effect.provideContext(services)),
      );
      expect((await request("/api/stats", { headers: { cookie: session } })).status).toBe(401);
    }
  }));

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import { dashboardCookie, Unauthorized } from "@aqt/turnstash-api";
import { sha256Hex } from "@aqt/turnstash-core";
import { and, eq, gt, lte } from "drizzle-orm";
import { Clock, Duration, Effect, Layer, Redacted, Schema } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { type OidcAuth, ServerConfig } from "./config.ts";
import { Db } from "./db/client.ts";
import { dashboardSessions } from "./db/schema.ts";
import { databaseFailure } from "./http-errors.ts";
import { callbackPath, LoginFailure, OpenId } from "./openid.ts";

const loginCookie = "__Host-turnstash-login";
const loginTtl = Duration.minutes(10);
const sessionTtl = Duration.hours(8);
const cookieOptions = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;
const privateHeaders = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const safeMethods = ["GET", "HEAD", "OPTIONS"];

const newToken = () => randomBytes(32).toString("hex");
const isToken = (value: string) => /^[a-f0-9]{64}$/.test(value);
const expiry = (now: number, ttl: Duration.Duration) => new Date(now + Duration.toMillis(ttl));

const PendingLogin = Schema.Struct({
  state: Schema.String,
  verifier: Schema.String,
  nonce: Schema.String,
  expiresAt: Schema.Number,
});
type PendingLogin = typeof PendingLogin.Type;
const decodePendingLogin = Schema.decodeUnknownEffect(Schema.fromJsonString(PendingLogin));

// The login's state, nonce and PKCE verifier travel in an encrypted cookie instead of a table row, so an
// unauthenticated /auth/login writes nothing. Replaying the cookie gains nothing: the provider's
// authorization code is single-use and bound to the PKCE challenge.
const loginKey = (auth: OidcAuth) =>
  Buffer.from(
    hkdfSync("sha256", Redacted.value(auth.clientSecret), "turnstash", "dashboard-login", 32),
  );
const ivBytes = 12;
const tagBytes = 16;

export const sealLogin = (auth: OidcAuth, login: PendingLogin): string => {
  const iv = randomBytes(ivBytes);
  const cipher = createCipheriv("aes-256-gcm", loginKey(auth), iv);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(login), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64url");
};

const openLogin = Effect.fn("Dashboard.openLogin")(function* (auth: OidcAuth, value: string) {
  const json = yield* Effect.try({
    try: () => {
      const bytes = Buffer.from(value, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", loginKey(auth), bytes.subarray(0, ivBytes));
      decipher.setAuthTag(bytes.subarray(ivBytes, ivBytes + tagBytes));
      return Buffer.concat([
        decipher.update(bytes.subarray(ivBytes + tagBytes)),
        decipher.final(),
      ]).toString("utf8");
    },
    catch: () => new LoginFailure({ step: "login" }),
  });
  return yield* decodePendingLogin(json).pipe(
    Effect.mapError(() => new LoginFailure({ step: "login" })),
  );
});

export const sameOrigin = (request: HttpServerRequest.HttpServerRequest, origin: string): boolean =>
  request.headers.origin === origin && request.headers["sec-fetch-site"] !== "cross-site";

export const dashboardSession = Effect.fn("Dashboard.session")(function* (token: string) {
  const { auth } = yield* ServerConfig;
  if (auth.mode !== "oidc" || !isToken(token)) return null;
  const db = yield* Db;
  const now = new Date(yield* Clock.currentTimeMillis);
  const [session] = yield* db
    .select({ subject: dashboardSessions.subject, name: dashboardSessions.name })
    .from(dashboardSessions)
    .where(
      and(
        eq(dashboardSessions.tokenHash, sha256Hex(token)),
        eq(dashboardSessions.subject, auth.adminSubject),
        gt(dashboardSessions.expiresAt, now),
      ),
    )
    .limit(1);
  return session ?? null;
});

export const authorizeDashboard = Effect.fn("Dashboard.authorize")(function* (token: string) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { auth } = yield* ServerConfig;
  const mutation = !safeMethods.includes(request.method);
  if (auth.mode !== "oidc" || (mutation && !sameOrigin(request, auth.origin))) {
    return yield* new Unauthorized({ reason: "invalid" });
  }
  const session = yield* dashboardSession(token);
  if (session === null) return yield* new Unauthorized({ reason: "invalid" });
  return session;
});

// The provider validates the callback against the configured origin, never the Host header a request carried.
const callbackUrl = (request: HttpServerRequest.HttpServerRequest, origin: string): URL => {
  const url = new URL(callbackPath, origin);
  url.search = new URL(request.url, origin).search;
  return url;
};

const showSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { auth } = yield* ServerConfig;
  const user = yield* dashboardSession(request.cookies[dashboardCookie] ?? "");
  return HttpServerResponse.jsonUnsafe({ mode: auth.mode, user }, { headers: privateHeaders });
});

const startLogin = Effect.gen(function* () {
  const { auth } = yield* ServerConfig;
  if (auth.mode !== "oidc") return HttpServerResponse.empty({ status: 404 });
  const openId = yield* OpenId;
  const login = yield* openId.start();
  const now = yield* Clock.currentTimeMillis;
  const sealed = sealLogin(auth, {
    state: login.state,
    verifier: login.verifier,
    nonce: login.nonce,
    expiresAt: expiry(now, loginTtl).getTime(),
  });
  return HttpServerResponse.redirect(login.url, { headers: privateHeaders }).pipe(
    HttpServerResponse.setCookieUnsafe(loginCookie, sealed, { ...cookieOptions, maxAge: loginTtl }),
  );
});

const finishLogin = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { auth } = yield* ServerConfig;
  if (auth.mode !== "oidc") return HttpServerResponse.empty({ status: 404 });
  const login = yield* openLogin(auth, request.cookies[loginCookie] ?? "");
  const now = yield* Clock.currentTimeMillis;
  if (login.expiresAt <= now) return yield* new LoginFailure({ step: "login" });
  const openId = yield* OpenId;
  const identity = yield* openId.finish(callbackUrl(request, auth.origin), login);
  const db = yield* Db;
  yield* db.delete(dashboardSessions).where(lte(dashboardSessions.expiresAt, new Date(now)));
  const sessionToken = newToken();
  yield* db.insert(dashboardSessions).values({
    tokenHash: sha256Hex(sessionToken),
    ...identity,
    expiresAt: expiry(now, sessionTtl),
  });
  return HttpServerResponse.redirect("/", { headers: privateHeaders }).pipe(
    HttpServerResponse.expireCookieUnsafe(loginCookie, cookieOptions),
    HttpServerResponse.setCookieUnsafe(dashboardCookie, sessionToken, {
      ...cookieOptions,
      maxAge: sessionTtl,
    }),
  );
});

const logout = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { auth } = yield* ServerConfig;
  if (auth.mode !== "oidc" || !sameOrigin(request, auth.origin))
    return HttpServerResponse.empty({ status: 403 });
  const db = yield* Db;
  const token = request.cookies[dashboardCookie] ?? "";
  yield* db.delete(dashboardSessions).where(eq(dashboardSessions.tokenHash, sha256Hex(token)));
  return HttpServerResponse.redirect("/", { status: 303, headers: privateHeaders }).pipe(
    HttpServerResponse.expireCookieUnsafe(dashboardCookie, cookieOptions),
  );
});

const loginFailed = (failure: LoginFailure) =>
  Effect.logWarning("dashboard sign-in failed", { step: failure.step, cause: failure.cause }).pipe(
    Effect.as(
      HttpServerResponse.text("Sign-in failed. Return to the dashboard and try again.", {
        status: 401,
        headers: privateHeaders,
      }).pipe(HttpServerResponse.expireCookieUnsafe(loginCookie, cookieOptions)),
    ),
  );

export const DashboardRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/auth/session", showSession.pipe(databaseFailure)),
  HttpRouter.add(
    "GET",
    "/auth/login",
    startLogin.pipe(Effect.catchTag("LoginFailure", loginFailed), databaseFailure),
  ),
  HttpRouter.add(
    "GET",
    callbackPath,
    finishLogin.pipe(
      Effect.catchTag("LoginFailure", loginFailed),
      databaseFailure,
      HttpMiddleware.withLoggerDisabled,
    ),
  ),
  HttpRouter.add("POST", "/auth/logout", logout.pipe(databaseFailure)),
);

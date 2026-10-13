import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";

import { version } from "../package.json" with { type: "json" };

export interface TokenAuth {
  readonly mode: "token";
  readonly adminToken: Redacted.Redacted;
}

export interface OidcAuth {
  readonly mode: "oidc";
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted;
  readonly origin: string;
  readonly adminSubject: string;
}

export type DashboardAuth = TokenAuth | OidcAuth;

export interface ServerConfigShape {
  readonly databaseUrl: Redacted.Redacted;
  readonly auth: DashboardAuth;
  readonly port: number;
  readonly webDist: Option.Option<string>;
  readonly workerIntervalMillis: number;
  readonly statementTimeoutMillis: number;
  readonly pricingRefreshHours: number;
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "@turnstash/ServerConfig",
) {}

const HttpsUrl = Schema.String.check(Schema.isPattern(/^https:\/\/[^?#]+$/));
const HttpsOrigin = Schema.String.check(Schema.isPattern(/^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?$/));
const StatementTimeout = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }));
const RefreshHours = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const secret = (name: string) => Config.NonEmptyString(name).pipe(Config.map(Redacted.make));

const tokenAuth = secret("ADMIN_TOKEN").pipe(
  Config.map((adminToken): DashboardAuth => ({ mode: "token", adminToken })),
);

const oidcAuth = Config.all({
  issuer: Config.schema(HttpsUrl, "OIDC_ISSUER"),
  clientId: Config.NonEmptyString("OIDC_CLIENT_ID"),
  clientSecret: secret("OIDC_CLIENT_SECRET"),
  origin: Config.schema(HttpsOrigin, "APP_ORIGIN"),
  adminSubject: Config.NonEmptyString("OIDC_ADMIN_SUBJECT"),
}).pipe(Config.map((oidc): DashboardAuth => ({ mode: "oidc", ...oidc })));

export const ServerConfigLive = Layer.effect(
  ServerConfig,
  Effect.gen(function* () {
    const issuer = yield* Config.String("OIDC_ISSUER").pipe(Config.withDefault(""));
    return ServerConfig.of({
      databaseUrl: yield* Config.Redacted("DATABASE_URL"),
      auth: yield* issuer === "" ? tokenAuth : oidcAuth,
      port: yield* Config.Int("PORT").pipe(Config.withDefault(4320)),
      webDist: yield* Config.String("WEB_DIST").pipe(Config.option),
      workerIntervalMillis: yield* Config.Int("WORKER_INTERVAL_MS").pipe(Config.withDefault(2000)),
      statementTimeoutMillis: yield* Config.schema(
        StatementTimeout,
        "DB_STATEMENT_TIMEOUT_MS",
      ).pipe(Config.withDefault(30_000)),
      pricingRefreshHours: yield* Config.schema(RefreshHours, "PRICING_REFRESH_HOURS").pipe(
        Config.withDefault(24),
      ),
    });
  }),
);

export const serverVersion = version;

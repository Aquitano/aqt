import { normalizers } from "@aqt/turnstash-providers";
import { BunHttpClient, BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";
import { HttpMiddleware, HttpRouter, HttpStaticServer } from "effect/unstable/http";

import { AuthLive } from "./auth.ts";
import { ServerConfig, ServerConfigLive } from "./config.ts";
import { DashboardRoutes } from "./dashboard-auth.ts";
import { DbLive, PgLive, runMigrations } from "./db/client.ts";
import { ApiLive } from "./http.ts";
import { callbackPath, OpenIdLive } from "./openid.ts";
import { normalizersLayer } from "./registry.ts";
import { GaugeSamplerLive, TelemetryLive } from "./telemetry.ts";
import { ensureBundledCatalog } from "./valuation.ts";
import { PricingRefreshLive, WorkerLive } from "./worker.ts";

const StaticLive = Layer.unwrap(
  Effect.map(ServerConfig, (config) =>
    Option.match(config.webDist, {
      onNone: () => Layer.empty,
      onSome: (root) => HttpStaticServer.layer({ root, spa: true }),
    }),
  ),
);

const Bootstrap = Layer.effectDiscard(Effect.andThen(runMigrations(), ensureBundledCatalog()));

const AppLive = Layer.mergeAll(ApiLive, StaticLive, DashboardRoutes).pipe(Layer.provide(AuthLive));

// The OIDC callback URL carries the one-time authorization code, so it stays out of traces as it does logs.
const CallbackUntraced = Layer.succeed(HttpMiddleware.TracerDisabledWhen)((request) =>
  request.url.startsWith(callbackPath),
);

const ServerLive = Layer.unwrap(
  Effect.map(ServerConfig, (config) =>
    HttpRouter.serve(AppLive).pipe(
      Layer.provide(BunHttpServer.layer({ port: config.port })),
      Layer.provide(CallbackUntraced),
    ),
  ),
);

const MainLive = Layer.mergeAll(ServerLive, WorkerLive, PricingRefreshLive, GaugeSamplerLive).pipe(
  Layer.provide(Bootstrap),
  Layer.provide(OpenIdLive),
  Layer.provide(Layer.mergeAll(DbLive, BunHttpClient.layer, normalizersLayer(normalizers))),
  Layer.provide(PgLive),
  Layer.provide(ServerConfigLive),
  Layer.provide(TelemetryLive.pipe(Layer.provide(BunHttpClient.layer))),
);

BunRuntime.runMain(Layer.launch(MainLive));

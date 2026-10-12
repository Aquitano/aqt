import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

import { ServerConfigLive } from "./config.ts";
import { PgLive, runMigrations } from "./db/client.ts";

BunRuntime.runMain(
  runMigrations().pipe(Effect.provide(PgLive.pipe(Layer.provide(ServerConfigLive)))),
);

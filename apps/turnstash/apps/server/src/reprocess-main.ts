import { normalizers } from "@aqt/turnstash-providers";
import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

import { ServerConfigLive } from "./config.ts";
import { DbLive, PgLive, runMigrations } from "./db/client.ts";
import { normalizersLayer } from "./registry.ts";
import { reprocessArchive } from "./reprocess.ts";

BunRuntime.runMain(
  Effect.gen(function* () {
    yield* runMigrations();
    const result = yield* reprocessArchive();
    yield* Effect.logInfo(
      "Archive queued for reprocessing; start the server worker to apply it",
      result,
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        DbLive.pipe(Layer.provideMerge(PgLive), Layer.provide(ServerConfigLive)),
        normalizersLayer(normalizers),
      ),
    ),
  ),
);

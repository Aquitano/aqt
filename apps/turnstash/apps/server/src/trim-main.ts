import { normalizers } from "@aqt/turnstash-providers";
import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

import { ServerConfigLive } from "./config.ts";
import { DbLive, PgLive, runMigrations } from "./db/client.ts";
import { normalizersLayer } from "./registry.ts";
import { trimArchive } from "./trim.ts";

BunRuntime.runMain(
  Effect.gen(function* () {
    yield* runMigrations();
    const result = yield* trimArchive();
    yield* Effect.logInfo(
      "Archive trimmed and queued; start the server so its worker rebuilds the conversations, then run VACUUM FULL to return the space",
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

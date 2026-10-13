import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { SqlError } from "effect/unstable/sql/SqlError";

import { failureSummary } from "./db/errors.ts";

// Deadlines and lost connections are the database being unavailable, not the request being wrong.
const unavailable = new Set(["StatementTimeoutError", "ConnectionError"]);

const isDatabaseError = Schema.is(Schema.Union([EffectDrizzleQueryError, SqlError]));
export const databaseFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(isDatabaseError, (error) => {
      const summary = failureSummary(error);
      return Effect.logError("database request failed", summary).pipe(
        Effect.as(
          HttpServerResponse.empty({
            status: unavailable.has(summary.reason) ? 503 : 500,
          }),
        ),
      );
    }),
  );

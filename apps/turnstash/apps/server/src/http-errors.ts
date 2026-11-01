import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { SqlError } from "effect/sql/SqlError";

import { failureSummary } from "./db/errors.ts";

// Deadlines, lost connections and exhausted server resources (SQLSTATE class 53) are the database being
// unavailable, not the request being wrong.
const unavailable = new Set(["StatementTimeoutError", "ConnectionError"]);
const isUnavailable = ({ reason, sqlState }: ReturnType<typeof failureSummary>) =>
  unavailable.has(reason) || sqlState?.startsWith("53") === true;

const isDatabaseError = Schema.is(Schema.Union([EffectDrizzleQueryError, SqlError]));
export const databaseFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(isDatabaseError, (error) => {
      const summary = failureSummary(error);
      return Effect.logError("database request failed", summary).pipe(
        Effect.as(
          HttpServerResponse.empty({
            status: isUnavailable(summary) ? 503 : 500,
          }),
        ),
      );
    }),
  );

import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import { Cause, Option, Schema } from "effect";
import { isSqlError, type SqlErrorReason } from "effect/sql/SqlError";

const hasSqlState = Schema.is(
  Schema.Struct({ code: Schema.String.check(Schema.isPattern(/^[0-9A-Z]{5}$/)) }),
);

export const failureSummary = (
  cause: unknown,
): {
  readonly reason: SqlErrorReason["_tag"] | "UnexpectedFailure";
  readonly sqlState?: string;
} => {
  if (Cause.isCause(cause))
    return failureSummary(Option.getOrUndefined(Cause.findErrorOption(cause)));
  if (cause instanceof EffectDrizzleQueryError) return failureSummary(cause.cause);
  if (!isSqlError(cause)) return { reason: "UnexpectedFailure" };
  const { reason } = cause;
  return hasSqlState(reason.cause)
    ? { reason: reason._tag, sqlState: reason.cause.code }
    : { reason: reason._tag };
};

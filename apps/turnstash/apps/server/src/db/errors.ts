import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import { Cause, Option, Schema } from "effect";
import { isSqlError, type SqlErrorReason } from "effect/sql/SqlError";

const hasSqlState = Schema.is(
  Schema.Struct({ code: Schema.String.check(Schema.isPattern(/^[0-9A-Z]{5}$/)) }),
);

// Only the driver's fixed names pass, so a log line tells a refused connection from a failed query without
// ever carrying SQL.
const Operation = Schema.Literals(["connect", "query", "commit"]);
const isOperation = Schema.is(Operation);

export const failureSummary = (
  cause: unknown,
): {
  readonly reason: SqlErrorReason["_tag"] | "UnexpectedFailure";
  readonly sqlState?: string;
  readonly operation?: typeof Operation.Type;
} => {
  if (Cause.isCause(cause))
    return failureSummary(Option.getOrUndefined(Cause.findErrorOption(cause)));
  if (cause instanceof EffectDrizzleQueryError) return failureSummary(cause.cause);
  if (!isSqlError(cause)) return { reason: "UnexpectedFailure" };
  const { reason } = cause;
  const operation = isOperation(reason.operation) ? { operation: reason.operation } : {};
  return hasSqlState(reason.cause)
    ? { reason: reason._tag, sqlState: reason.cause.code, ...operation }
    : { reason: reason._tag, ...operation };
};

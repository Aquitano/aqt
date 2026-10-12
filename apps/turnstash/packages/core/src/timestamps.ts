import { Predicate, type Schema } from "effect";

export const isoTimestampOf = (value: Schema.Json | undefined): string | undefined => {
  const millis = Predicate.isNumber(value)
    ? value
    : Predicate.isString(value)
      ? Date.parse(value)
      : Number.NaN;
  return Number.isFinite(millis) && Math.abs(millis) <= 8.64e15
    ? new Date(millis).toISOString()
    : undefined;
};

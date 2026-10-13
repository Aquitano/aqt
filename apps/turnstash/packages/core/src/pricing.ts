import { Schema } from "effect";

export const RouteId = Schema.Literals(["bedrock", "vertex", "openrouter"]);
export type RouteId = typeof RouteId.Type;

export const UnpricedReason = Schema.Literals([
  "unknown_model",
  "local_model",
  "free_model",
  "subscription_model",
  "zero_rate",
]);
export type UnpricedReason = typeof UnpricedReason.Type;

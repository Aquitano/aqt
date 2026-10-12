import { Schema } from "effect";

import { NulFreeString } from "./records.ts";

const PerMillion = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const AliasRule = Schema.Struct({ kind: Schema.Literal("alias"), target: NulFreeString });
export const RateRule = Schema.Struct({
  kind: Schema.Literal("rate"),
  inputPerMillion: PerMillion,
  outputPerMillion: PerMillion,
  cacheWritePerMillion: Schema.optionalKey(PerMillion),
  cacheReadPerMillion: Schema.optionalKey(PerMillion),
});
export type RateRule = typeof RateRule.Type;
export const UnpricedRule = Schema.Struct({
  kind: Schema.Literal("unpriced"),
  reason: Schema.Literals(["free", "subscription", "local"]),
});

export const PricingRule = Schema.Union([AliasRule, RateRule, UnpricedRule]);
export type PricingRule = typeof PricingRule.Type;

export const PricingRules = Schema.Record(Schema.String, PricingRule);
export type PricingRules = typeof PricingRules.Type;

export const ruleKey = (model: string): string => model.trim().toLowerCase();

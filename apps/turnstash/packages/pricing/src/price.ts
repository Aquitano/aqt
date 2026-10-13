import {
  type RateRule,
  type RequestSpeed,
  ruleKey,
  type UnpricedReason,
  type Usage,
} from "@aqt/turnstash-core";
import { Equal } from "effect";

import { type Catalog, hasBillableRate, type ModelCosts } from "./catalog.ts";
import {
  canonicalModelId,
  canonicalName,
  looksLikeLocalModel,
  resolveAlias,
  routedCandidates,
  stripPinAndDate,
  stripVariantSuffix,
  userRuleFor,
} from "./resolve.ts";

// Bump on any pricing change outside catalog entries (aliases, routes, resolution, tiers, rules): valuations
// written by an older version are recomputed and never carried over to a new catalog.
export const pricingVersion = 2;

export interface PriceHit {
  readonly priceKey: string;
  readonly costs: ModelCosts;
  readonly fromRule?: true;
}

const hit = (catalog: Catalog, key: string): PriceHit | null => {
  const costs =
    catalog.primary.get(key) ??
    catalog.fallback.get(key) ??
    catalog.lowercaseIndex.get(key.toLowerCase());
  return costs === undefined ? null : { priceKey: key, costs };
};

export const lookupPrice = (catalog: Catalog, model: string): PriceHit | null => {
  const withPrefix = stripPinAndDate(model);
  const name = canonicalName(catalog, model);
  const canonical = resolveAlias(catalog, name);

  // A curated alias for a bare id beats a reseller row the bundler stripped to the same name.
  if (canonical !== name && withPrefix === name) {
    const aliased = hit(catalog, canonical);
    if (aliased) return aliased;
  }
  const direct = hit(catalog, model) ?? hit(catalog, withPrefix) ?? hit(catalog, canonical);
  if (direct) return direct;

  for (const candidate of routedCandidates(catalog, model)) {
    const routed = hit(catalog, resolveAlias(catalog, candidate)) ?? hit(catalog, candidate);
    if (routed) return routed;
  }

  const prefixVariant = stripVariantSuffix(withPrefix);
  if (prefixVariant !== null) {
    const variant = lookupPrice(catalog, prefixVariant);
    if (variant) return variant;
  }
  const canonicalVariant = stripVariantSuffix(canonical);
  if (canonicalVariant !== null && canonicalVariant !== prefixVariant) {
    const variant = lookupPrice(catalog, canonicalVariant);
    if (variant) return variant;
  }
  for (
    let i = canonical.lastIndexOf("-");
    i >= 0;
    i = i === 0 ? -1 : canonical.lastIndexOf("-", i - 1)
  ) {
    const prefix = canonical.slice(0, i);
    const prefixHit = hit(catalog, prefix);
    if (prefixHit) return prefixHit;
  }
  return null;
};

const oneHourCacheWriteMultiplier = 1.6;

// xAI bills every bucket at the high tier once the prompt crosses the threshold.
const promptTiers: ReadonlyArray<{
  readonly modelId: string;
  readonly promptTokens: number;
  readonly costs: ModelCosts;
}> = [
  {
    modelId: "grok-4.6",
    promptTokens: 200_000,
    costs: {
      inputPerToken: 4e-6,
      outputPerToken: 12e-6,
      cacheWritePerToken: 5e-6,
      cacheReadPerToken: 1e-6,
      cacheWriteExplicit: false,
      fastMultiplier: 1,
    },
  },
];

export type CostBreakdown = {
  readonly inputUsd: number;
  readonly outputUsd: number;
  readonly cacheWriteUsd: number;
  readonly cacheWrite1hUsd: number;
  readonly cacheReadUsd: number;
  readonly multiplier: number;
};

const unpricedReasonOfRule: Record<"free" | "subscription" | "local", UnpricedReason> = {
  free: "free_model",
  subscription: "subscription_model",
  local: "local_model",
};

const costsOfRateRule = (rule: RateRule): ModelCosts => ({
  inputPerToken: rule.inputPerMillion / 1e6,
  outputPerToken: rule.outputPerMillion / 1e6,
  cacheWritePerToken: (rule.cacheWritePerMillion ?? rule.inputPerMillion * 1.25) / 1e6,
  cacheReadPerToken: (rule.cacheReadPerMillion ?? rule.inputPerMillion * 0.1) / 1e6,
  cacheWriteExplicit: rule.cacheWritePerMillion !== undefined,
  fastMultiplier: 1,
});

const userHit = (model: string, rule: RateRule): PriceHit => ({
  priceKey: `user:${model}`,
  costs: costsOfRateRule(rule),
  fromRule: true,
});

const isFreeTier = (model: string): boolean =>
  /(?:-free|:free)$/i.test(model.slice(model.lastIndexOf("/") + 1));

export type Valuation =
  | {
      readonly kind: "priced";
      readonly priceKey: string;
      readonly costUsd: number;
      readonly breakdown: CostBreakdown;
    }
  | {
      readonly kind: "unpriced";
      readonly reason: UnpricedReason;
      readonly priceKey: string | null;
    };

export interface PriceInput {
  readonly modelRaw: string;
  readonly usage: Usage;
  readonly speed?: RequestSpeed | undefined;
}

export const findPrice = (
  catalog: Catalog,
  modelRaw: string,
): PriceHit | Extract<Valuation, { kind: "unpriced" }> => {
  const matched = userRuleFor(catalog, modelRaw);
  switch (matched?.rule.kind) {
    case "unpriced":
      return {
        kind: "unpriced",
        reason: unpricedReasonOfRule[matched.rule.reason],
        priceKey: `user:${matched.model}`,
      };
    case "rate":
      return userHit(matched.model, matched.rule);
    case "alias": {
      const target = ruleKey(matched.rule.target);
      const targetRule = catalog.rules.get(target);
      if (targetRule?.kind === "unpriced")
        return {
          kind: "unpriced",
          reason: unpricedReasonOfRule[targetRule.reason],
          priceKey: `user:${target}`,
        };
      const found =
        targetRule?.kind === "rate" ? userHit(target, targetRule) : lookupPrice(catalog, target);
      return (
        found ?? { kind: "unpriced", reason: "unknown_model", priceKey: `user:${matched.model}` }
      );
    }
    case undefined: {
      if (isFreeTier(modelRaw)) return { kind: "unpriced", reason: "free_model", priceKey: null };
      const candidates = routedCandidates(catalog, modelRaw).map((candidate) =>
        resolveAlias(catalog, stripVariantSuffix(candidate) ?? candidate),
      );
      if (candidates.every(looksLikeLocalModel))
        return { kind: "unpriced", reason: "local_model", priceKey: null };
      const found = lookupPrice(catalog, modelRaw);
      return found ?? { kind: "unpriced", reason: "unknown_model", priceKey: null };
    }
  }
};

// Prompt tiers are keyed by model id, so a changed id can reprice a model whose rates stayed the same.
export const repricedModels = (
  current: Catalog,
  next: Catalog,
  models: Iterable<string>,
): ReadonlyArray<string> =>
  [...models].filter(
    (model) =>
      !Equal.equals(findPrice(current, model), findPrice(next, model)) ||
      canonicalModelId(current, model) !== canonicalModelId(next, model),
  );

export const priceRequest = (catalog: Catalog, input: PriceInput): Valuation => {
  const found = findPrice(catalog, input.modelRaw);
  if ("kind" in found) return found;
  if (!hasBillableRate(found.costs))
    return { kind: "unpriced", reason: "zero_rate", priceKey: found.priceKey };

  const { usage } = input;
  const modelId = canonicalModelId(catalog, input.modelRaw);
  const tier = found.fromRule
    ? undefined
    : promptTiers.find(
        (candidate) =>
          candidate.modelId === modelId &&
          usage.inputTokens + usage.cacheReadTokens >= candidate.promptTokens,
      );
  const costs = tier?.costs ?? found.costs;
  const multiplier = input.speed === "fast" ? costs.fastMultiplier : 1;
  const breakdown: CostBreakdown = {
    inputUsd: usage.inputTokens * costs.inputPerToken * multiplier,
    outputUsd: usage.outputTokens * costs.outputPerToken * multiplier,
    cacheWriteUsd: usage.cacheWriteTokens * costs.cacheWritePerToken * multiplier,
    cacheWrite1hUsd:
      usage.cacheWrite1hTokens *
      costs.cacheWritePerToken *
      oneHourCacheWriteMultiplier *
      multiplier,
    cacheReadUsd: usage.cacheReadTokens * costs.cacheReadPerToken * multiplier,
    multiplier,
  };
  return {
    kind: "priced",
    priceKey: found.priceKey,
    costUsd:
      breakdown.inputUsd +
      breakdown.outputUsd +
      breakdown.cacheWriteUsd +
      breakdown.cacheWrite1hUsd +
      breakdown.cacheReadUsd,
    breakdown,
  };
};

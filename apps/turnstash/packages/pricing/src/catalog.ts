import { type PricingRule, PricingRules, ruleKey, sha256Hex } from "@aqt/turnstash-core";
import { Schema } from "effect";

import snapshotJson from "../data/litellm-snapshot.json" with { type: "json" };
import fallbackJson from "../data/pricing-fallback.json" with { type: "json" };

export const RateTuple = Schema.Array(Schema.NullOr(Schema.Finite)).check(
  Schema.isMinLength(2),
  Schema.isMaxLength(5),
);
export type RateTuple = typeof RateTuple.Type;

export const CatalogEntries = Schema.Struct({
  primary: Schema.Record(Schema.String, RateTuple),
  fallback: Schema.Record(Schema.String, RateTuple),
  rules: Schema.optionalKey(PricingRules),
});
export type CatalogEntries = typeof CatalogEntries.Type;

export interface ModelCosts {
  readonly inputPerToken: number;
  readonly outputPerToken: number;
  readonly cacheWritePerToken: number;
  readonly cacheReadPerToken: number;
  readonly cacheWriteExplicit: boolean;
  readonly fastMultiplier: number;
}

// Rates LiteLLM does not carry, applied over both the bundled snapshot and every refresh.
// Cursor publishes house-model rates only on cursor.com/docs/models, so LiteLLM never carries
// them; drop each of the other rows once upstream ships it.
const builtinPriceOverrides: Readonly<Record<string, RateTuple>> = {
  "composer-2.5": [0.5e-6, 2.5e-6, 0.5e-6, 0.2e-6, null],
  "composer-2": [0.5e-6, 2.5e-6, 0.5e-6, 0.2e-6, null],
  "composer-1.5": [3.5e-6, 17.5e-6, 3.5e-6, 0.35e-6, null],
  "composer-1": [1.25e-6, 10e-6, 1.25e-6, 0.125e-6, null],
  "MiniMax-M2.7": [0.3e-6, 1.2e-6, 0.375e-6, 0.06e-6, null],
  "MiniMax-M2.7-highspeed": [0.6e-6, 2.4e-6, 0.375e-6, 0.06e-6, null],
  "deepseek-v4-flash": [1.4e-7, 2.8e-7, 0, 2.8e-9, null],
  "deepseek-v4-pro": [4.35e-7, 8.7e-7, 0, 3.625e-9, null],
  "claude-mythos-5": [10e-6, 50e-6, 12.5e-6, 1e-6, null],
  "gpt-5.6-codex": [5e-6, 3e-5, 6.25e-6, 5e-7, null],
  "gpt-5.6-codex-max": [5e-6, 3e-5, 6.25e-6, 5e-7, null],
};

const maxPerTokenRate = 1;

const safeRate = (rate: number | null | undefined): number | null =>
  rate === null || rate === undefined || rate < 0 ? null : Math.min(rate, maxPerTokenRate);

const costsOfTuple = (tuple: RateTuple): ModelCosts | null => {
  const input = safeRate(tuple[0]);
  const output = safeRate(tuple[1]);
  if (input === null || output === null) return null;
  const cacheWrite = safeRate(tuple[2]);
  const fast = tuple[4];
  return {
    inputPerToken: input,
    outputPerToken: output,
    cacheWritePerToken: cacheWrite ?? input * 1.25,
    cacheReadPerToken: safeRate(tuple[3]) ?? input * 0.1,
    cacheWriteExplicit: cacheWrite !== null,
    fastMultiplier: fast === null || fast === undefined || fast <= 0 ? 1 : fast,
  };
};

export const hasBillableRate = (costs: ModelCosts): boolean =>
  costs.inputPerToken > 0 ||
  costs.outputPerToken > 0 ||
  costs.cacheWritePerToken > 0 ||
  costs.cacheReadPerToken > 0;

export interface Catalog {
  readonly version: string;
  readonly entries: CatalogEntries;
  readonly primary: ReadonlyMap<string, ModelCosts>;
  readonly fallback: ReadonlyMap<string, ModelCosts>;
  readonly lowercaseIndex: ReadonlyMap<string, ModelCosts>;
  readonly namespaces: ReadonlySet<string>;
  readonly rules: ReadonlyMap<string, PricingRule>;
}

const sortedRecord = (record: Readonly<Record<string, RateTuple>>): Record<string, RateTuple> =>
  Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key] ?? []]),
  );

const sortedRules = (rules: PricingRules): PricingRules =>
  Object.fromEntries(
    Object.entries(rules)
      .map(([model, rule]) => [ruleKey(model), rule] as const)
      .filter(([model]) => model !== "")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

// Rules are omitted when empty so rule-free versions keep their historical hash.
const canonicalEntries = (entries: CatalogEntries): CatalogEntries => {
  const rules = sortedRules(entries.rules ?? {});
  return {
    primary: sortedRecord(entries.primary),
    fallback: sortedRecord(entries.fallback),
    ...(Object.keys(rules).length === 0 ? {} : { rules }),
  };
};

export const withRules = (entries: CatalogEntries, rules: PricingRules): CatalogEntries =>
  canonicalEntries({ primary: entries.primary, fallback: entries.fallback, rules });

export const catalogVersion = (entries: CatalogEntries): string =>
  `litellm-${sha256Hex(JSON.stringify(canonicalEntries(entries))).slice(0, 16)}`;

export const withBuiltinOverrides = (
  primary: Readonly<Record<string, RateTuple>>,
): Record<string, RateTuple> => ({
  ...primary,
  ...builtinPriceOverrides,
});

const localNamespaces = new Set(["ollama"]);

// Wrapper prefixes that appear in transcripts but never as catalog key prefixes.
const extraNamespaces = [
  "cp",
  "cline-pass",
  "cline-free",
  "cmd",
  "antigravity",
  "orcarouter",
  "cliproxy",
  "litellm_proxy",
  "openai_like",
  "zhipu",
  "mimo",
  "kimi",
  "zcode",
  "opencode",
  "opencode-go",
  "runpod",
  "github-copilot",
];

export const makeCatalog = (input: CatalogEntries): Catalog => {
  const entries = canonicalEntries(input);
  const primary = new Map<string, ModelCosts>();
  for (const [key, tuple] of Object.entries(entries.primary)) {
    const costs = costsOfTuple(tuple);
    if (costs) primary.set(key, costs);
  }
  const fallback = new Map<string, ModelCosts>();
  for (const [key, tuple] of Object.entries(entries.fallback)) {
    const costs = costsOfTuple(tuple);
    if (costs) fallback.set(key, costs);
  }
  const lowercaseIndex = new Map<string, ModelCosts>();
  const priced = (costs: ModelCosts) => costs.inputPerToken > 0 || costs.outputPerToken > 0;
  for (const [key, costs] of primary) {
    const lower = key.toLowerCase();
    if (priced(costs) && !lowercaseIndex.has(lower)) lowercaseIndex.set(lower, costs);
  }
  for (const [key, costs] of fallback) {
    const lower = key.toLowerCase();
    if (priced(costs) && !lowercaseIndex.has(lower)) lowercaseIndex.set(lower, costs);
  }
  const namespaces = new Set(extraNamespaces);
  for (const key of [...primary.keys(), ...fallback.keys()]) {
    const slash = key.indexOf("/");
    if (slash > 0) namespaces.add(key.slice(0, slash).toLowerCase());
  }
  for (const local of localNamespaces) namespaces.delete(local);
  return {
    version: catalogVersion(entries),
    entries,
    primary,
    fallback,
    lowercaseIndex,
    namespaces,
    rules: new Map(Object.entries(entries.rules ?? {})),
  };
};

const decodeEntries = Schema.decodeUnknownSync(CatalogEntries);

export const bundledEntries: CatalogEntries = decodeEntries({
  primary: withBuiltinOverrides(
    Schema.decodeUnknownSync(Schema.Record(Schema.String, RateTuple))(snapshotJson),
  ),
  fallback: fallbackJson,
});

export const bundledCatalog: Catalog = makeCatalog(bundledEntries);

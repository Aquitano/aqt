import { expect, test } from "bun:test";

import { emptyUsage } from "@aqt/turnstash-core";

import {
  bundledCatalog,
  bundledEntries,
  type Catalog,
  catalogVersion,
  makeCatalog,
  withRules,
} from "../src/catalog.ts";
import { refreshedEntries } from "../src/litellm.ts";
import { lookupPrice, priceRequest, repricedModels } from "../src/price.ts";
import { resolveModel } from "../src/resolve.ts";

const catalog = bundledCatalog;
const priced = (
  from: Catalog,
  modelRaw: string,
  usage: Partial<typeof emptyUsage>,
  speed?: "fast",
) => {
  const valuation = priceRequest(from, { modelRaw, usage: { ...emptyUsage, ...usage }, speed });
  if (valuation.kind !== "priced") throw new Error(`expected priced, got ${valuation.reason}`);
  return valuation;
};

test("every bundled fallback row beats a shorter primary key", () => {
  for (const [model, tuple] of Object.entries(bundledEntries.fallback)) {
    if (catalog.primary.has(model)) continue;
    const [input, output] = tuple;
    if (input == null || output == null) continue;
    const found = lookupPrice(catalog, model);
    expect(found?.costs.inputPerToken).toBe(input);
    expect(found?.costs.outputPerToken).toBe(output);
  }
  for (const model of ["glm-4.7-flashx", "mistral-medium-3.1"])
    expect(lookupPrice(catalog, model)?.priceKey).toBe(model);
});

test("variants resolve before prefix fallback, and free and exacto suffixes are remote", () => {
  const million = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  expect(priced(catalog, "claude-opus-4-5:thinking", million).costUsd).toBeCloseTo(30);
  expect(resolveModel(catalog, "claude-opus-4-5:thinking").modelId).toBe("claude-opus-4-5");
  const routed = makeCatalog({
    primary: {
      "openrouter/vendor/model:exacto": [2e-6, 3e-6],
      "openrouter/vendor/model:free": [0, 0],
      "vendor/model": [4e-6, 5e-6],
    },
    fallback: {},
  });
  expect(priced(routed, "openrouter/vendor/model:exacto", million).costUsd).toBeCloseTo(5);
  for (const modelRaw of ["openrouter/vendor/model:free", "openrouter/vendor/unknown:free"])
    expect(priceRequest(routed, { modelRaw, usage: emptyUsage })).toMatchObject({
      kind: "unpriced",
      reason: "free_model",
    });
  expect(
    priceRequest(routed, { modelRaw: "ollama/model:latest", usage: emptyUsage }),
  ).toMatchObject({
    kind: "unpriced",
    reason: "local_model",
  });
});

test("OpenCode and Pi route names preserve regional and Vertex rows", () => {
  const raw = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
  const million = { inputTokens: 1_000_000 };
  const expected = priced(catalog, raw, million);
  for (const model of [`amazon-bedrock/${raw}`, `bedrock/${raw}`]) {
    expect(priced(catalog, model, million).costUsd).toBeCloseTo(expected.costUsd);
    expect(resolveModel(catalog, model)).toEqual({
      modelId: "claude-sonnet-4-5",
      route: { id: "bedrock", label: "Bedrock", variant: "us" },
    });
  }
  expect(priced(catalog, "google-vertex/gemini-2.5-pro", million).costUsd).toBeCloseTo(
    priced(catalog, "vertex_ai/gemini-2.5-pro", million).costUsd,
  );
  expect(resolveModel(catalog, "google-vertex/gemini-2.5-pro").route?.id).toBe("vertex");
  expect(resolveModel(catalog, "anthropic.claude-opus-4-6-v1").modelId).toBe("claude-opus-4-6");
  expect(resolveModel(catalog, "amazon-bedrock/claude-opus-4-6-v1").modelId).toBe(
    "claude-opus-4-6",
  );
});

test("prefix fallback selects the longest hyphen boundary and preserves leading delimiters", () => {
  const prefixes = makeCatalog({
    primary: { family: [1e-6, 2e-6], "family-pro": [3e-6, 4e-6] },
    fallback: {},
  });
  expect(lookupPrice(prefixes, "family-pro-extra")?.priceKey).toBe("family-pro");
  expect(lookupPrice(prefixes, "family-proextra")?.priceKey).toBe("family");
  expect(lookupPrice(prefixes, "familyextra")).toBeNull();
  expect(lookupPrice(prefixes, "unknown-extra")).toBeNull();

  const leading = makeCatalog({ primary: { "": [1e-6, 2e-6] }, fallback: {} });
  expect(lookupPrice(leading, "-extra-part")?.priceKey).toBe("");
  expect(lookupPrice(leading, "unknown-extra")).toBeNull();
});

test("a case-insensitive hit on a prefixed-only key reports that prefixed key", () => {
  const prefixed = makeCatalog({ primary: { "acme/Widget-1": [1e-6, 2e-6] }, fallback: {} });
  expect(lookupPrice(prefixed, "acme/widget-1")?.priceKey).toBe("acme/widget-1");
});

test("5m and 1h cache writes bill at their own rates", () => {
  const rated = makeCatalog({ primary: { "cache-model": [1e-6, 4e-6, 2e-6, 5e-7] }, fallback: {} });
  const valuation = priced(rated, "cache-model-20250929", {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
    cacheWrite1hTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
  });
  expect(valuation.priceKey).toBe("cache-model");
  expect(valuation.breakdown.inputUsd).toBeCloseTo(1);
  expect(valuation.breakdown.outputUsd).toBeCloseTo(4);
  expect(valuation.breakdown.cacheWriteUsd).toBeCloseTo(2);
  expect(valuation.breakdown.cacheWrite1hUsd).toBeCloseTo(3.2);
  expect(valuation.breakdown.cacheReadUsd).toBeCloseTo(0.5);
  expect(valuation.costUsd).toBeCloseTo(10.7);
});

test("Bedrock cross-region ids price at the Bedrock row and resolve to the base model", () => {
  const raw = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
  const regional = makeCatalog({
    primary: { "claude-sonnet-4-5": [1e-6, 5e-6], [raw]: [1.1e-6, 5.5e-6] },
    fallback: {},
  });
  expect(lookupPrice(regional, raw)?.priceKey).toBe(raw);
  expect(priced(regional, raw, { inputTokens: 1_000_000 }).breakdown.inputUsd).toBeCloseTo(1.1);
  expect(resolveModel(regional, raw)).toEqual({
    modelId: "claude-sonnet-4-5",
    route: { id: "bedrock", label: "Bedrock", variant: "us" },
  });
  expect(resolveModel(regional, "claude-sonnet-4-5", "amazon-bedrock").route?.id).toBe("bedrock");
});

test("aliases, gateway prefixes and vertex pins collapse to one model id", () => {
  expect(resolveModel(catalog, "Claude Sonnet 4.5").modelId).toBe("claude-sonnet-4-5");
  expect(resolveModel(catalog, "openrouter/anthropic/claude-opus-4.6")).toEqual({
    modelId: "claude-opus-4-6",
    route: { id: "openrouter", label: "OpenRouter" },
  });
  expect(resolveModel(catalog, "claude-sonnet-4-5@20250929")).toEqual({
    modelId: "claude-sonnet-4-5",
    route: { id: "vertex", label: "Vertex AI" },
  });
  expect(resolveModel(catalog, "GPT-5.3 Codex (high reasoning)").modelId).toBe("gpt-5.3-codex");
  expect(lookupPrice(catalog, "cliproxy/zcode/glm-5.3")?.priceKey).toBe("z-ai/glm-5.3");
  expect(lookupPrice(catalog, "opencode-go/glm-5.3-flash")?.priceKey).toBe("glm-5.3-flash");
  expect(resolveModel(catalog, "opencode-go/deepseek-v4-pro").modelId).toBe("deepseek-v4-pro");
});

test("fast mode applies the catalog multiplier and reasoning is not billed twice", () => {
  const rated = makeCatalog({
    primary: { "fast-model": [1e-6, 2e-6, null, null, 2] },
    fallback: {},
  });
  const usage = { outputTokens: 1_000, reasoningTokens: 900 };
  const standard = priced(rated, "fast-model", usage);
  const fast = priced(rated, "fast-model", usage, "fast");
  expect(standard.costUsd).toBeCloseTo(0.002);
  expect(fast.costUsd).toBeCloseTo(0.004);
  expect(fast.breakdown.multiplier).toBe(2);
});

test("unknown, local and zero-rate models come back unpriced with a reason", () => {
  expect(priceRequest(catalog, { modelRaw: "totally-made-up-9000", usage: emptyUsage })).toEqual({
    kind: "unpriced",
    reason: "unknown_model",
    priceKey: null,
  });
  expect(priceRequest(catalog, { modelRaw: "qwen3.6:35b-a3b-bf16", usage: emptyUsage })).toEqual({
    kind: "unpriced",
    reason: "local_model",
    priceKey: null,
  });
  expect(
    priceRequest(catalog, { modelRaw: "opencode/x-preview-f-free", usage: emptyUsage }),
  ).toEqual({ kind: "unpriced", reason: "free_model", priceKey: null });
  expect(resolveModel(catalog, "github-copilot/claude-sonnet-4.5").modelId).toBe(
    "claude-sonnet-4-5",
  );
  const stubbed = makeCatalog({ primary: { "free-stub": [0, 0, null, null, null] }, fallback: {} });
  expect(priceRequest(stubbed, { modelRaw: "free-stub", usage: emptyUsage })).toEqual({
    kind: "unpriced",
    reason: "zero_rate",
    priceKey: "free-stub",
  });
});

test("a model or route hint named after an Object.prototype member is unknown, not a crash", () => {
  for (const name of ["toString", "constructor", "__proto__"]) {
    expect(priceRequest(catalog, { modelRaw: name, usage: emptyUsage })).toEqual({
      kind: "unpriced",
      reason: "unknown_model",
      priceKey: null,
    });
    expect(resolveModel(catalog, name, name)).toEqual({ modelId: name, route: null });
  }
});

test("catalog versions are stable across key order and refreshes carry dropped rows forward", () => {
  const reordered = {
    primary: Object.fromEntries(Object.entries(bundledEntries.primary).reverse()),
    fallback: bundledEntries.fallback,
  };
  expect(catalogVersion(reordered)).toBe(catalog.version);
  expect(catalog.version).toMatch(/^litellm-[a-f0-9]{16}$/);
  const refreshed = refreshedEntries(bundledEntries, {
    "anthropic/claude-sonnet-4-5": {
      input_cost_per_token: 4e-6,
      output_cost_per_token: 2e-5,
      cache_read_input_token_cost: 4e-7,
    },
    sample_spec: { input_cost_per_token: 1 },
  });
  expect(refreshed.primary["claude-sonnet-4-5"]).toEqual([4e-6, 2e-5, null, 4e-7, null]);
  expect(refreshed.primary["composer-2"]).toEqual(bundledEntries.primary["composer-2"]);
  expect(refreshed.fallback["gpt-5.5"]).toEqual(bundledEntries.primary["gpt-5.5"]);
  expect(makeCatalog(refreshed).version).not.toBe(catalog.version);
  const million = { inputTokens: 1_000_000 };
  expect(priced(makeCatalog(refreshed), "gpt-5.5", million)).toEqual(
    priced(catalog, "gpt-5.5", million),
  );
});

test("a model dropped, re-listed at a new rate and dropped again keeps the newer rate", () => {
  const listed = (rate: number) => ({
    "drift-model": { input_cost_per_token: rate, output_cost_per_token: rate },
  });
  const dropped = refreshedEntries(
    refreshedEntries({ primary: {}, fallback: {} }, listed(1e-6)),
    {},
  );
  const droppedAgain = refreshedEntries(refreshedEntries(dropped, listed(2e-6)), {});
  expect(
    priced(makeCatalog(droppedAgain), "drift-model", { inputTokens: 1_000_000 }).costUsd,
  ).toBeCloseTo(2);
});

test("repricedModels lists only the models a new catalog prices differently", () => {
  const before = makeCatalog({
    primary: { "gpt-6-sol": [2e-6, 1e-5], "gpt-6-luna": [1e-6, 5e-6] },
    fallback: {},
  });
  const after = makeCatalog({
    primary: {
      "gpt-6-sol": [2e-6, 1e-5],
      "gpt-6-luna": [1.5e-6, 5e-6],
      "gpt-6.1-sol": [2e-6, 1e-5],
    },
    fallback: {},
  });
  expect(
    repricedModels(before, after, [
      "gpt-6-sol",
      "gpt-6-luna-2026-09-22",
      "gpt-6.1-sol",
      "qwen3:8b",
    ]),
  ).toEqual(["gpt-6-luna-2026-09-22", "gpt-6.1-sol"]);
});

test("cloud aliases price normally while quantized local variants stay unpriced", () => {
  const expected = priced(catalog, "gpt-5.5", { inputTokens: 1_000 });
  for (const model of [
    "openai-codex:gpt-5.5",
    "omniroute:gpt-5.5",
    "gpt-5.5:cloud",
    "gpt-5.5:thinking",
  ]) {
    expect(priced(catalog, model, { inputTokens: 1_000 })).toEqual(expected);
  }
  for (const modelRaw of ["gpt-5.5:latest", "gpt-5.5-q4_K_M", "omniroute:qwen3:8b"]) {
    expect(priceRequest(catalog, { modelRaw, usage: emptyUsage })).toMatchObject({
      kind: "unpriced",
      reason: "local_model",
    });
  }
});

test("user rules beat the catalog: rates, aliases, classifications and the version they change", () => {
  const ruled = makeCatalog(
    withRules(bundledEntries, {
      "My-Proxy-Model": { kind: "alias", target: "claude-opus-5" },
      "qwen38-27b": { kind: "rate", inputPerMillion: 1, outputPerMillion: 2 },
      "claude-sonnet-4-5": { kind: "rate", inputPerMillion: 0, outputPerMillion: 0 },
      "codex-auto-review": { kind: "unpriced", reason: "subscription" },
    }),
  );
  const million = { ...emptyUsage, inputTokens: 1_000_000, outputTokens: 1_000_000 };
  expect(ruled.version).not.toBe(catalog.version);
  expect(makeCatalog(withRules(bundledEntries, {})).version).toBe(catalog.version);

  expect(priceRequest(ruled, { modelRaw: "opencode-go/qwen38-27b", usage: million })).toMatchObject(
    { kind: "priced", priceKey: "user:qwen38-27b", costUsd: 3 },
  );
  expect(priceRequest(ruled, { modelRaw: "claude-sonnet-4-5", usage: million })).toEqual({
    kind: "unpriced",
    reason: "zero_rate",
    priceKey: "user:claude-sonnet-4-5",
  });
  const bedrock = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
  expect(priceRequest(ruled, { modelRaw: bedrock, usage: million })).toMatchObject({
    kind: "priced",
    priceKey: bedrock,
  });
  expect(priceRequest(ruled, { modelRaw: "codex-auto-review", usage: million })).toEqual({
    kind: "unpriced",
    reason: "subscription_model",
    priceKey: "user:codex-auto-review",
  });

  const aliased = priceRequest(ruled, { modelRaw: "my-proxy-model", usage: million });
  expect(aliased).toEqual(priceRequest(ruled, { modelRaw: "claude-opus-5", usage: million }));
  expect(resolveModel(ruled, "MY-PROXY-MODEL").modelId).toBe("claude-opus-5");
  expect(resolveModel(catalog, "my-proxy-model").modelId).toBe("my-proxy-model");
});

test("user rules win over prompt tiers, alias targets keep their case and unpriced status, and route prefixes regroup", () => {
  const ruled = makeCatalog(
    withRules(bundledEntries, {
      "grok-4.6": { kind: "rate", inputPerMillion: 1, outputPerMillion: 1 },
      "gpt-5.5": { kind: "unpriced", reason: "subscription" },
      "proxy-gpt": { kind: "alias", target: "GPT-5.5" },
      "openrouter/weird-model": { kind: "alias", target: "Claude-Opus-5" },
    }),
  );
  expect(
    priceRequest(ruled, { modelRaw: "grok-4.6", usage: { ...emptyUsage, inputTokens: 300_000 } }),
  ).toMatchObject({ kind: "priced", costUsd: 0.3 });
  expect(priceRequest(ruled, { modelRaw: "proxy-gpt", usage: emptyUsage })).toEqual({
    kind: "unpriced",
    reason: "subscription_model",
    priceKey: "user:gpt-5.5",
  });
  expect(resolveModel(ruled, "openrouter/weird-model").modelId).toBe("claude-opus-5");
  expect(resolveModel(ruled, "openrouter/weird-model").route?.id).toBe("openrouter");
});

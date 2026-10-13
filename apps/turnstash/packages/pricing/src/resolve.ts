import { type PricingRule, ruleKey } from "@aqt/turnstash-core";

import { builtinAliases } from "./aliases.ts";
import type { Catalog } from "./catalog.ts";
import { modelRoute, type Route, routeFromProviderField } from "./routes.ts";

const pinSuffix = /@.*$/;
const dateSuffix = /-\d{8}$/;
const bracketSuffix = /\[[^\]]*\]$/;

// Gateway spellings that wrap a model id without being one.
const routerPrefixes: ReadonlyArray<RegExp> = [
  /^omniroute:/i,
  /^cp\//i,
  /^cline-pass\//i,
  /^cline-free\//i,
  /^cmd\//i,
  /^antigravity\//i,
  /^orcarouter\//i,
  /^cliproxy\//i,
];

const aliasOf = (catalog: Catalog, model: string): string | undefined => {
  const rule = catalog.rules.get(ruleKey(model));
  if (rule?.kind === "alias") return ruleKey(rule.target);
  const direct = builtinAliases.get(model);
  if (direct !== undefined) return direct;
  const lower = model.toLowerCase();
  return lower === model ? undefined : builtinAliases.get(lower);
};

export const resolveAlias = (catalog: Catalog, model: string): string =>
  aliasOf(catalog, model) ?? model;

export const stripPinAndDate = (model: string): string =>
  model.replace(pinSuffix, "").replace(dateSuffix, "");

export const stripVariantSuffix = (model: string): string | null => {
  const withoutColon = model.replace(/:(thinking|cloud|exacto)$/i, "");
  if (withoutColon !== model) return withoutColon;
  const withoutTee = model.replace(/-TEE$/i, "");
  return withoutTee === model ? null : withoutTee;
};

const stripKnownFirstNamespace = (catalog: Catalog, model: string): string => {
  const slash = model.indexOf("/");
  if (slash <= 0) return model;
  return catalog.namespaces.has(model.slice(0, slash).toLowerCase())
    ? model.slice(slash + 1)
    : model;
};

export const canonicalName = (catalog: Catalog, model: string): string => {
  const cleaned = stripPinAndDate(model).replace(bracketSuffix, "");
  return aliasOf(catalog, cleaned) === undefined
    ? stripKnownFirstNamespace(catalog, cleaned)
    : cleaned;
};

export const canonicalModelId = (catalog: Catalog, model: string): string => {
  const base = modelRoute(model)?.baseModel ?? model;
  const aliased = resolveAlias(catalog, canonicalName(catalog, stripVariantSuffix(base) ?? base));
  if (!aliased.includes("/")) return aliased;
  const leaf = aliased.slice(aliased.lastIndexOf("/") + 1);
  return leaf === "" ? aliased : resolveAlias(catalog, canonicalName(catalog, leaf));
};

const candidatesOf = (
  catalog: Catalog,
  model: string,
  withRoutes: boolean,
): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const candidates: Array<string> = [];
  const push = (value: string) => {
    if (value === "" || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };
  push(model);
  let current = model;
  let peeled = true;
  while (peeled) {
    peeled = false;
    for (const prefix of routerPrefixes) {
      const next = current.replace(prefix, "");
      if (next !== "" && next !== current) {
        current = next;
        push(current);
        peeled = true;
      }
    }
  }
  const routed = withRoutes ? modelRoute(current) : null;
  if (routed !== null) {
    const slash = current.indexOf("/");
    if (slash > 0) {
      const rest = current.slice(slash + 1);
      const namespace = routed.route.id === "vertex" ? "vertex_ai" : routed.route.id;
      push(`${namespace}/${rest}`);
      push(rest);
    }
  }
  push(canonicalName(catalog, current));
  if (routed !== null) {
    push(routed.baseModel);
    push(canonicalName(catalog, routed.baseModel));
  }
  return candidates;
};

export const routedCandidates = (catalog: Catalog, model: string): ReadonlyArray<string> =>
  candidatesOf(catalog, model, true);

export interface MatchedRule {
  readonly model: string;
  readonly rule: PricingRule;
}

// A rule names the model as logs spell it, so a rule for a bare model does not also claim the
// same model billed per token through a Bedrock or Vertex route.
export const userRuleFor = (catalog: Catalog, model: string): MatchedRule | null => {
  if (catalog.rules.size === 0) return null;
  for (const candidate of candidatesOf(catalog, model, false)) {
    const key = ruleKey(candidate);
    const rule = catalog.rules.get(key);
    if (rule !== undefined) return { model: key, rule };
  }
  return null;
};

export interface ResolvedModel {
  readonly modelId: string;
  readonly route: Route | null;
}

export const resolveModel = (
  catalog: Catalog,
  modelRaw: string,
  routeHint?: string | null,
): ResolvedModel => {
  const routed = modelRoute(modelRaw);
  const matched = userRuleFor(catalog, modelRaw);
  return {
    modelId:
      matched?.rule.kind === "alias"
        ? canonicalModelId(catalog, ruleKey(matched.rule.target))
        : canonicalModelId(catalog, routed?.baseModel ?? modelRaw),
    route: routeFromProviderField(routeHint) ?? routed?.route ?? null,
  };
};

// Ollama and LM Studio tags carry `:tag`; quantized fingerprints end in q4_K_M, bf16 and friends.
export const looksLikeLocalModel = (model: string): boolean => {
  if (/:(thinking|cloud|exacto|free|batch)$/i.test(model)) return false;
  if (/-v?\d+:\d+$/.test(model)) return false;
  if (/^arn:aws:bedrock:/i.test(model)) return false;
  if (model.includes(":") && !model.startsWith("http")) return true;
  return /[-_](q[2-8](_[a-z0-9]+)*|bf16|fp16|gguf|f16|f32)$/i.test(model);
};

import type { RouteId } from "@aqt/turnstash-core";

export type Route = {
  readonly id: RouteId;
  readonly label: string;
  readonly variant?: string;
};

export type RoutedModel = {
  readonly route: Route;
  readonly baseModel: string;
};

const routeLabels: Readonly<Record<RouteId, string>> = {
  bedrock: "Bedrock",
  vertex: "Vertex AI",
  openrouter: "OpenRouter",
};

const providerFields: ReadonlyMap<string, RouteId> = new Map(
  Object.entries({
    bedrock: "bedrock",
    "amazon-bedrock": "bedrock",
    openrouter: "openrouter",
    vertex: "vertex",
    vertex_ai: "vertex",
    "google-vertex": "vertex",
  }),
);

const prefixRoutes: ReadonlyArray<readonly [string, RouteId]> = [
  ["bedrock/", "bedrock"],
  ["amazon-bedrock/", "bedrock"],
  ["openrouter/", "openrouter"],
  ["vertex_ai/", "vertex"],
  ["vertex/", "vertex"],
  ["google-vertex/", "vertex"],
];

// Bedrock foundation-model id: `[<inference profile>.]<vendor>.<model>[-v<major>:<minor>]`.
// Only the two vendors that emit coding transcripts are recognised, so a plain
// dotted id from anywhere else (`deepseek.v3.2`, `glm-4.7`) is left alone.
const bedrockId =
  /^(?:(us|eu|apac|global|jp|au|us-gov)\.)?(?:anthropic|openai)\.([a-z0-9][a-z0-9.-]*?)(?:-v\d+(?::\d+)?)?$/i;

const vertexPinnedId = /^(.+)@[A-Za-z0-9.-]+$/;

const routeOf = (id: RouteId, variant?: string): Route =>
  variant === undefined ? { id, label: routeLabels[id] } : { id, label: routeLabels[id], variant };

const leaf = (model: string): string =>
  model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;

const bedrockModel = (model: string): RoutedModel | null => {
  const match = bedrockId.exec(model);
  const baseModel = match?.[2];
  if (baseModel === undefined) return null;
  return { route: routeOf("bedrock", match?.[1]?.toLowerCase()), baseModel };
};

/// The billing door a model id names, with the door's wrapping removed, or null
/// for a plain vendor id. Pure: no catalog lookup, safe on the parse path.
export const modelRoute = (model: string): RoutedModel | null => {
  const direct = bedrockModel(model);
  if (direct) return direct;

  for (const [prefix, id] of prefixRoutes) {
    if (!model.toLowerCase().startsWith(prefix)) continue;
    const rest = model.slice(prefix.length);
    if (rest === "") return null;
    if (id === "bedrock")
      return (
        bedrockModel(leaf(rest)) ?? {
          route: routeOf("bedrock"),
          baseModel: leaf(rest).replace(/-v\d+(?::\d+)?$/i, ""),
        }
      );
    return { route: routeOf(id), baseModel: rest };
  }

  const pinned = vertexPinnedId.exec(model)?.[1];
  if (pinned !== undefined) return { route: routeOf("vertex"), baseModel: pinned };

  return null;
};

/// The route a provider's own endpoint field names (`model_provider`, `providerID`),
/// or null for any value not in `providerFields`.
export const routeFromProviderField = (value: string | null | undefined): Route | null => {
  if (!value) return null;
  const id = providerFields.get(value.trim().toLowerCase());
  return id === undefined ? null : routeOf(id);
};

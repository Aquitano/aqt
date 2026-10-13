import { Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { type CatalogEntries, type RateTuple, withBuiltinOverrides } from "./catalog.ts";

const liteLLMUrl =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const Rate = Schema.optional(Schema.NullOr(Schema.Finite));

const LiteLLMEntry = Schema.Struct({
  input_cost_per_token: Rate,
  output_cost_per_token: Rate,
  cache_creation_input_token_cost: Rate,
  cache_read_input_token_cost: Rate,
  provider_specific_entry: Schema.optional(Schema.NullOr(Schema.Struct({ fast: Rate }))),
});

export const LiteLLMDocument = Schema.Record(Schema.String, Schema.Json);
export type LiteLLMDocument = typeof LiteLLMDocument.Type;

const decodeEntry = Schema.decodeUnknownOption(LiteLLMEntry);

const tupleOf = (value: Schema.Json): RateTuple | null => {
  const entry = decodeEntry(value);
  if (Option.isNone(entry)) return null;
  const { input_cost_per_token: input, output_cost_per_token: output } = entry.value;
  if (input === null || input === undefined || output === null || output === undefined) return null;
  return [
    input,
    output,
    entry.value.cache_creation_input_token_cost ?? null,
    entry.value.cache_read_input_token_cost ?? null,
    entry.value.provider_specific_entry?.fast ?? null,
  ];
};

const completeness = (tuple: RateTuple): number =>
  (tuple[2] == null ? 0 : 1) + (tuple[3] == null ? 0 : 1);

// A richer prefixed row may only fill missing cache slots of a stripped key, never re-price it.
const fillsOnly = (candidate: RateTuple, existing: RateTuple): boolean =>
  candidate[0] === existing[0] &&
  candidate[1] === existing[1] &&
  (existing[2] == null || candidate[2] === existing[2]) &&
  (existing[3] == null || candidate[3] === existing[3]);

const primaryEntriesFromLiteLLM = (document: LiteLLMDocument): Record<string, RateTuple> => {
  const primary: Record<string, RateTuple> = {};
  const rows = Object.entries(document).filter(([name]) => name !== "sample_spec");
  for (const [name, value] of rows) {
    if (name.includes("/")) continue;
    const tuple = tupleOf(value);
    if (tuple) primary[name] = tuple;
  }
  for (const [name, value] of rows) {
    if (!name.includes("/")) continue;
    const tuple = tupleOf(value);
    if (!tuple) continue;
    primary[name] ??= tuple;
    const stripped = name.replace(/^[^/]+\//, "");
    const existing = primary[stripped];
    if (
      existing === undefined ||
      (completeness(tuple) > completeness(existing) && fillsOnly(tuple, existing))
    ) {
      primary[stripped] = tuple;
    }
  }
  return withBuiltinOverrides(primary);
};

// Rows the new upstream dropped stay priced at their last known rate in the fallback tier.
export const refreshedEntries = (
  previous: CatalogEntries,
  document: LiteLLMDocument,
): CatalogEntries => {
  const primary = primaryEntriesFromLiteLLM(document);
  const fallback: Record<string, RateTuple> = { ...previous.fallback };
  for (const [key, tuple] of Object.entries(previous.primary)) {
    if (primary[key] === undefined) fallback[key] = tuple;
  }
  return { primary, fallback };
};

export const fetchLiteLLM = Effect.fn("Pricing.fetchLiteLLM")(function* (url: string = liteLLMUrl) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const response = yield* client.get(url);
  return yield* HttpClientResponse.schemaBodyJson(LiteLLMDocument)(response);
});

import { ProviderId, providerIds, providerLabels } from "@aqt/turnstash-api";
import { Schema } from "effect";

export const isProvider = Schema.is(ProviderId);

export const providerOptions = providerIds.map((provider) => ({
  value: provider,
  label: providerLabels[provider],
}));

import type { ProviderId } from "@aqt/turnstash-api";

export interface PlanPreset {
  readonly id: string;
  readonly label: string;
  readonly provider: ProviderId;
  readonly name: string;
  readonly monthlyPrice: number;
}

const preset = (
  provider: ProviderId,
  name: string,
  monthlyPrice: number,
  label = name,
): PlanPreset => ({ id: `${provider}:${name}`, label, provider, name, monthlyPrice });

// List prices in USD as of 2026-09; they only prefill the form and stay editable before saving.
export const planPresets: ReadonlyArray<PlanPreset> = [
  preset("claude", "Claude Pro", 20),
  preset("claude", "Claude Max 5x", 100),
  preset("claude", "Claude Max 20x", 200),
  preset("codex", "ChatGPT Plus", 20),
  preset("codex", "ChatGPT Pro", 200),
  preset("cursor", "Cursor Pro", 20),
  preset("cursor", "Cursor Pro+", 60),
  preset("cursor", "Cursor Ultra", 200),
  preset("copilot", "GitHub Copilot Pro", 10),
  preset("copilot", "GitHub Copilot Pro+", 39),
  preset("gemini", "Google AI Pro", 19.99, "Google AI Pro (Gemini CLI)"),
  preset("gemini", "Google AI Ultra", 249.99, "Google AI Ultra (Gemini CLI)"),
  preset("antigravity", "Google AI Pro", 19.99, "Google AI Pro (Antigravity)"),
  preset("antigravity", "Google AI Ultra", 249.99, "Google AI Ultra (Antigravity)"),
];

export const currencies: ReadonlyArray<string> = ["USD", "EUR", "GBP"];

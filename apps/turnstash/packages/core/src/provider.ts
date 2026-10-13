import { Schema } from "effect";

export const providerIds = [
  "claude",
  "codex",
  "opencode",
  "cursor",
  "copilot",
  "gemini",
  "pi",
  "antigravity",
] as const;

export const ProviderId = Schema.Literals(providerIds);
export type ProviderId = typeof ProviderId.Type;

export const providerLabels: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  copilot: "GitHub Copilot",
  gemini: "Gemini CLI",
  pi: "Pi",
  antigravity: "Antigravity",
};

import type { Normalizer, ProviderId, SourceProvider } from "@aqt/turnstash-core";

import { antigravityNormalizer, antigravitySource } from "./antigravity/index.ts";
import { claudeNormalizer, claudeSource } from "./claude/index.ts";
import { codexNormalizer, codexSource } from "./codex/index.ts";
import { copilotNormalizer, copilotSource } from "./copilot/index.ts";
import { cursorNormalizer, cursorSource } from "./cursor/index.ts";
import { geminiNormalizer, geminiSource } from "./gemini/index.ts";
import { opencodeNormalizer, opencodeSource } from "./opencode/index.ts";
import { piNormalizer, piSource } from "./pi/index.ts";

export const sourceProviders: ReadonlyArray<SourceProvider> = [
  claudeSource,
  codexSource,
  opencodeSource,
  cursorSource,
  copilotSource,
  geminiSource,
  piSource,
  antigravitySource,
];

export const normalizers: Readonly<Record<ProviderId, Normalizer>> = {
  claude: claudeNormalizer,
  codex: codexNormalizer,
  opencode: opencodeNormalizer,
  cursor: cursorNormalizer,
  copilot: copilotNormalizer,
  gemini: geminiNormalizer,
  pi: piNormalizer,
  antigravity: antigravityNormalizer,
};

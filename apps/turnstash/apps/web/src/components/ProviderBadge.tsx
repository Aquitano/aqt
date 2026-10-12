import { providerLabels, type ProviderId } from "@aqt/turnstash-api";
import { Badge, type BadgeVariant } from "@cloudflare/kumo";

const variants: Record<ProviderId, BadgeVariant> = {
  claude: "orange",
  codex: "neutral",
  opencode: "teal",
  cursor: "blue",
  copilot: "purple",
  gemini: "green",
  pi: "red",
  antigravity: "blue",
};

export const ProviderBadge = ({ provider }: { readonly provider: ProviderId }) => (
  <Badge variant={variants[provider]}>{providerLabels[provider]}</Badge>
);

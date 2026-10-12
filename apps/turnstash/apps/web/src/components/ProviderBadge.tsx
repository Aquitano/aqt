import { providerLabels, type ProviderId } from "@aqt/turnstash-api";
import { Badge } from "@aqt/ui/components/badge";

const dots: Record<ProviderId, string> = {
  claude: "bg-flame",
  codex: "bg-foreground",
  opencode: "bg-chart-5",
  cursor: "bg-chart-1",
  copilot: "bg-chart-4",
  gemini: "bg-success",
  pi: "bg-destructive",
  antigravity: "bg-chart-2",
};

export const ProviderBadge = ({ provider }: { readonly provider: ProviderId }) => (
  <Badge variant="outline">
    <span className={`size-1.5 rounded-full ${dots[provider]}`} />
    {providerLabels[provider]}
  </Badge>
);

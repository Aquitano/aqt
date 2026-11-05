import type { ProviderId } from "@aqt/turnstash-api";
import { cn } from "cn";
import { CodeXmlIcon, OrbitIcon, PiIcon } from "lucide-react";
import type { ComponentType } from "react";
import { siClaude, siCursor, siGithubcopilot, siGooglegemini, siOpencode } from "simple-icons";

const brandMark =
  (path: string): ComponentType<{ readonly className?: string }> =>
  ({ className }) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d={path} />
    </svg>
  );

const marks: Record<ProviderId, ComponentType<{ readonly className?: string }>> = {
  claude: brandMark(siClaude.path),
  codex: CodeXmlIcon,
  opencode: brandMark(siOpencode.path),
  cursor: brandMark(siCursor.path),
  copilot: brandMark(siGithubcopilot.path),
  gemini: brandMark(siGooglegemini.path),
  pi: PiIcon,
  antigravity: OrbitIcon,
};

const colors: Record<ProviderId, string> = {
  claude: "text-provider-claude",
  codex: "text-provider-codex",
  opencode: "text-provider-opencode",
  cursor: "text-provider-cursor",
  copilot: "text-provider-copilot",
  gemini: "text-provider-gemini",
  pi: "text-provider-pi",
  antigravity: "text-provider-antigravity",
};

export const ProviderIcon = ({
  provider,
  className,
}: {
  readonly provider: ProviderId;
  readonly className?: string;
}) => {
  const Mark = marks[provider];
  return <Mark className={cn("size-4 shrink-0", colors[provider], className)} />;
};

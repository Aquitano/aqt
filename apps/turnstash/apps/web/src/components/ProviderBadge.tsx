import { providerLabels, type ProviderId } from "@aqt/turnstash-api";

import { ProviderIcon } from "./ProviderIcon";

export const ProviderBadge = ({ provider }: { readonly provider: ProviderId }) => (
  <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
    <ProviderIcon provider={provider} className="size-3.5" />
    {providerLabels[provider]}
  </span>
);

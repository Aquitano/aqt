import { useState } from "react";
import type { ReactNode } from "react";

import { Page, PageHead } from "../components/Page";
import { Segmented } from "../components/Segmented";
import { DisplaySettings } from "../settings/DisplaySettings";
import { MachinesSettings } from "../settings/MachinesSettings";
import { PlansSettings } from "../settings/PlansSettings";
import { PricingSettings } from "../settings/PricingSettings";
import { TokensSettings } from "../settings/TokensSettings";

const tabs = [
  { value: "display", label: "Display" },
  { value: "machines", label: "Machines" },
  { value: "plans", label: "Plans" },
  { value: "tokens", label: "Tokens" },
  { value: "pricing", label: "Pricing" },
] as const;

type TabId = (typeof tabs)[number]["value"];

const panels: Record<TabId, () => ReactNode> = {
  display: DisplaySettings,
  machines: MachinesSettings,
  plans: PlansSettings,
  tokens: TokensSettings,
  pricing: PricingSettings,
};

export const SettingsPage = () => {
  const [tab, setTab] = useState<TabId>("display");
  const Panel = panels[tab];

  return (
    <Page>
      <PageHead
        title="Settings"
        note={<Segmented label="Settings section" options={tabs} value={tab} onChange={setTab} />}
      />
      <Panel />
    </Page>
  );
};

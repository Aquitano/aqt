import { Tabs } from "@cloudflare/kumo";
import { useState } from "react";
import type { ReactNode } from "react";

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

const isTabId = (value: string): value is TabId => tabs.some((tab) => tab.value === value);

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
    <main className="main">
      <div className="page-head">
        <h1 className="page-title">Settings</h1>
        <Tabs
          variant="segmented"
          size="sm"
          tabs={tabs.map((entry) => ({ value: entry.value, label: entry.label }))}
          value={tab}
          onValueChange={(value) => {
            if (isTabId(value)) setTab(value);
          }}
        />
      </div>
      <Panel />
    </main>
  );
};

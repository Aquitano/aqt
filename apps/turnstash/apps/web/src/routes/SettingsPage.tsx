import { Tabs, TabsContent, TabsList, TabsTrigger } from "@aqt/ui/components/tabs";

import { Page, PageHead } from "../components/Page";
import { DisplaySettings } from "../settings/DisplaySettings";
import { MachinesSettings } from "../settings/MachinesSettings";
import { PlansSettings } from "../settings/PlansSettings";
import { PricingSettings } from "../settings/PricingSettings";
import { TokensSettings } from "../settings/TokensSettings";

const tabs = [
  { value: "display", label: "Display", Panel: DisplaySettings },
  { value: "machines", label: "Machines", Panel: MachinesSettings },
  { value: "plans", label: "Plans", Panel: PlansSettings },
  { value: "tokens", label: "Tokens", Panel: TokensSettings },
  { value: "pricing", label: "Pricing", Panel: PricingSettings },
] as const;

export const SettingsPage = () => (
  <Page>
    <Tabs defaultValue={tabs[0].value} className="gap-9">
      <PageHead
        title="Settings"
        note={
          <TabsList aria-label="Settings section" className="h-8 max-w-full overflow-x-auto">
            {tabs.map(({ value, label }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="px-2.5 max-sm:px-1.5 max-sm:text-xs"
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        }
      />
      {tabs.map(({ value, Panel }) => (
        <TabsContent key={value} value={value} className="flex flex-col gap-9">
          <Panel />
        </TabsContent>
      ))}
    </Tabs>
  </Page>
);

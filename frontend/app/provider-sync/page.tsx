import { PageHeader } from "@/components/PageHeader";
import { ProviderSyncPanel } from "@/components/ProviderSyncPanel";
import { StatusBar } from "@/components/StatusBar";
import { getProviderSyncPageData } from "@/lib/aqtHealthApi";

export default async function ProviderSyncPage() {
  const data = await getProviderSyncPageData();

  return (
    <>
      <PageHeader
        eyebrow="Provider workflows"
        title="Provider sync"
        description="Check provider readiness, start OAuth, and manually sync supported data types."
      />
      <StatusBar apiBaseUrl={data.apiBaseUrl} health={data.health} />
      <ProviderSyncPanel catalog={data.providerCatalog} statuses={data.providerStatuses} />
    </>
  );
}

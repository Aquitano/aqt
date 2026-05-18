import { IngestionBatchDetail } from "@/components/IngestionBatchDetail";
import { PageHeader } from "@/components/PageHeader";
import { StatusBar } from "@/components/StatusBar";
import { getHealthStatus, getIngestionBatchDetail } from "@/lib/aqtHealthApi";

type PageProps = {
  params: Promise<{
    batchId: string;
  }>;
};

export default async function IngestionBatchDetailPage({ params }: PageProps) {
  const { batchId } = await params;
  const [status, batch] = await Promise.all([
    getHealthStatus(),
    getIngestionBatchDetail(batchId),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Ingestion detail"
        title={`Ingestion batch #${batchId}`}
        description="Batch metadata, normalized records, and stored payloads for audit/debugging."
      />
      <StatusBar apiBaseUrl={status.apiBaseUrl} health={status.health} />
      <IngestionBatchDetail result={batch} />
    </>
  );
}

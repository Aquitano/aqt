import { Suspense } from "react";
import { DashboardCards } from "@/components/DashboardCards";
import { DataSection } from "@/components/DataSection";
import { DateRangeForm } from "@/components/DateRangeForm";
import { ErrorNotice } from "@/components/ErrorNotice";
import { JsonDetails } from "@/components/JsonDetails";
import { ProviderSyncPanel } from "@/components/ProviderSyncPanel";
import { StatusBar } from "@/components/StatusBar";
import { BodyMeasurementsTable } from "@/components/tables/BodyMeasurementsTable";
import { DailyStepsTable } from "@/components/tables/DailyStepsTable";
import { HeartRateTable } from "@/components/tables/HeartRateTable";
import { IngestionBatchesTable } from "@/components/tables/IngestionBatchesTable";
import { SleepSessionsTable } from "@/components/tables/SleepSessionsTable";
import { getDashboardData } from "@/lib/aqtHealthApi";
import { parseDateRange } from "@/lib/dates";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Home({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};
  const range = parseDateRange({
    fromDate: params.fromDate,
    toDate: params.toDate,
  });
  const data = await getDashboardData(range.fromDate, range.toDate);
  const summary = data.summary.ok ? data.summary.data : undefined;

  return (
    <main className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Local health hub</p>
          <h1>aqt-health</h1>
        </div>
        <Suspense>
          <DateRangeForm fromDate={range.fromDate} toDate={range.toDate} />
        </Suspense>
      </header>

      <StatusBar
        apiBaseUrl={data.apiBaseUrl}
        health={data.health}
        fromDate={range.fromDate}
        toDate={range.toDate}
      />
      {range.warning ? <div className="notice warning">{range.warning}</div> : null}
      <ErrorNotice result={data.health} />
      <ErrorNotice result={data.summary} />

      <DashboardCards summary={summary} />

      <ProviderSyncPanel catalog={data.providerCatalog} statuses={data.providerStatuses} />

      <div className="grid">
        <DataSection title="Daily steps" result={data.dailySteps}>
          {(response) => <DailyStepsTable items={response.items} />}
        </DataSection>

        <DataSection title="Latest weight" result={data.latestWeight}>
          {(response) => <BodyMeasurementsTable items={response.items} />}
        </DataSection>

        <DataSection title="Latest heart rate" result={data.latestHeartRate}>
          {(response) => <HeartRateTable items={response.items} />}
        </DataSection>

        <DataSection title="Latest sleep" result={data.latestSleep}>
          {(response) => <SleepSessionsTable items={response.items} />}
        </DataSection>

        <DataSection title="Recent ingestion batches" result={data.batches}>
          {(response) => <IngestionBatchesTable items={response.items} />}
        </DataSection>

        <DataSection title="Recent ingestion failures" result={data.failures}>
          {(response) => <IngestionBatchesTable items={response.items} />}
        </DataSection>
      </div>

      <JsonDetails title="Raw dashboard response" value={data.summary} />
    </main>
  );
}

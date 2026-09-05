import { DashboardCards } from "@/components/DashboardCards";
import { DataSection } from "@/components/DataSection";
import { DateRangeForm } from "@/components/DateRangeForm";
import { DebugDataPanel } from "@/components/DebugDataPanel";
import { DayOverview } from "@/components/DayOverview";
import { ErrorNotice } from "@/components/ErrorNotice";
import { HealthDataVisualizations } from "@/components/HealthDataVisualizations";
import { LoadingPulse } from "@/components/motion/LoadingPulse";
import { MetricHighlights } from "@/components/MetricHighlights";
import { PageHeader } from "@/components/PageHeader";
import { StatusBar } from "@/components/StatusBar";
import { ActivitySummariesTable } from "@/components/tables/ActivitySummariesTable";
import { BloodPressureTable } from "@/components/tables/BloodPressureTable";
import { BodyMeasurementsTable } from "@/components/tables/BodyMeasurementsTable";
import { CardiovascularTable } from "@/components/tables/CardiovascularTable";
import { DailyStepsTable } from "@/components/tables/DailyStepsTable";
import { ExtendedBodyMeasurementsTable } from "@/components/tables/ExtendedBodyMeasurementsTable";
import { HeartRateTable } from "@/components/tables/HeartRateTable";
import { HrvTable } from "@/components/tables/HrvTable";
import { RespiratoryRateTable } from "@/components/tables/RespiratoryRateTable";
import { SleepSessionsTable } from "@/components/tables/SleepSessionsTable";
import { SleepSummariesTable } from "@/components/tables/SleepSummariesTable";
import { getHealthDataPageSources } from "@/lib/aqtHealthApi";
import { addUtcDays, parseDateRange } from "@/lib/dates";
import type { BodyMeasurement, HealthDataPageSources } from "@/lib/types";
import { Suspense } from "react";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function HealthDataPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};
  const range = parseDateRange({
    fromDate: params.fromDate,
    toDate: params.toDate,
    timezone: params.timezone,
  });

  const sources = getHealthDataPageSources(range.fromDate, range.toDate, range.timezone);

  return (
    <>
      <PageHeader
        eyebrow="Local health hub"
        title="Health data"
        description="Daily overview and recent normalized metrics across connected providers."
        actions={
          <Suspense>
            <DateRangeForm fromDate={range.fromDate} toDate={range.toDate} />
          </Suspense>
        }
      />

      {range.warning ? <div className="notice warning">{range.warning}</div> : null}

      <Suspense fallback={<LoadingPulse />}>
        <OverviewSection
          sources={sources}
          fromDate={range.fromDate}
          toDate={range.toDate}
          timezone={range.timezone}
        />
      </Suspense>

      <Suspense fallback={<LoadingPulse label="Loading visual analytics…" />}>
        <VisualizationsSection
          sources={sources}
          fromDate={range.fromDate}
          toDate={range.toDate}
          timezone={range.timezone}
        />
      </Suspense>

      <Suspense fallback={<LoadingPulse label="Loading raw data…" />}>
        <DebugSection sources={sources} />
      </Suspense>
    </>
  );
}

async function OverviewSection({
  sources,
  fromDate,
  toDate,
  timezone,
}: {
  sources: HealthDataPageSources;
  fromDate: string;
  toDate: string;
  timezone: string;
}) {
  const [
    health,
    summary,
    trends,
    healthDay,
    bodyMeasurements,
    latestActivity,
    latestSleepSummary,
    latestRespiratoryRate,
    latestHrv,
    latestBloodPressure,
  ] = await Promise.all([
    sources.health,
    sources.summary,
    sources.trends,
    sources.healthDay,
    sources.bodyMeasurements,
    sources.latestActivity,
    sources.latestSleepSummary,
    sources.latestRespiratoryRate,
    sources.latestHrv,
    sources.latestBloodPressure,
  ]);

  console.info(JSON.stringify({
    event: "health_data_route_overview_completed",
    page: "/health-data",
    fromDate,
    toDate,
    timezone,
  }));

  const bodyMeasurementItems = bodyMeasurements.ok ? bodyMeasurements.data.items : [];
  const weightTrendItems = bodyMeasurementItems.filter((item) => isWeightTrendItem(item, toDate));
  const weightDelta = weightChange(weightTrendItems);

  return (
    <>
      <StatusBar
        apiBaseUrl={sources.apiBaseUrl}
        health={health}
        fromDate={fromDate}
        toDate={toDate}
      />
      <ErrorNotice result={health} />
      <ErrorNotice result={summary} />
      <ErrorNotice result={trends} />
      <ErrorNotice result={healthDay} />
      <ErrorNotice result={bodyMeasurements} />

      <DashboardCards
        summary={summary.ok ? summary.data : undefined}
        trends={trends.ok ? trends.data : undefined}
      />
      <DayOverview
        day={healthDay.ok ? healthDay.data : undefined}
        weightDelta7d={weightDelta?.value}
        weightDelta7dUnit={weightDelta?.unit}
      />

      <MetricHighlights
        latestActivity={latestActivity.ok ? latestActivity.data : undefined}
        latestSleepSummary={latestSleepSummary.ok ? latestSleepSummary.data : undefined}
        latestRespiratoryRate={latestRespiratoryRate.ok ? latestRespiratoryRate.data : undefined}
        latestHrv={latestHrv.ok ? latestHrv.data : undefined}
        latestBloodPressure={latestBloodPressure?.ok ? latestBloodPressure.data : undefined}
      />
    </>
  );
}

async function VisualizationsSection({
  sources,
  fromDate,
  toDate,
  timezone,
}: {
  sources: HealthDataPageSources;
  fromDate: string;
  toDate: string;
  timezone: string;
}) {
  const [
    activitySummaries,
    bodyMeasurements,
    dailySteps,
    heartRateDaily,
    hrvSamples,
    sleepNights,
    respiratoryRates,
    sleepSummaries,
  ] = await Promise.all([
    sources.activitySummaries,
    sources.bodyMeasurements,
    sources.dailySteps,
    sources.heartRateDaily,
    sources.hrvSamples,
    sources.sleepNights,
    sources.respiratoryRates,
    sources.sleepSummaries,
  ]);

  return (
    <HealthDataVisualizations
      activitySummaries={activitySummaries.ok ? activitySummaries.data : undefined}
      bodyMeasurements={bodyMeasurements.ok ? bodyMeasurements.data : undefined}
      dailySteps={dailySteps.ok ? dailySteps.data : undefined}
      heartRateDaily={heartRateDaily}
      hrvSamples={hrvSamples.ok ? hrvSamples.data : undefined}
      sleepNights={sleepNights.ok ? sleepNights.data : undefined}
      respiratoryRates={respiratoryRates.ok ? respiratoryRates.data : undefined}
      sleepSummaries={sleepSummaries.ok ? sleepSummaries.data : undefined}
      fromDate={fromDate}
      toDate={toDate}
      timezone={timezone}
    />
  );
}

async function DebugSection({ sources }: { sources: HealthDataPageSources }) {
  const [
    dailySteps,
    activitySummaries,
    bodyMeasurements,
    latestHeartRate,
    sleepNights,
    sleepSummaries,
    respiratoryRates,
    hrvSamples,
    bloodPressure,
    cardiovascular,
    extendedBodyMeasurements,
  ] = await Promise.all([
    sources.dailySteps,
    sources.activitySummaries,
    sources.bodyMeasurements,
    sources.latestHeartRate,
    sources.sleepNights,
    sources.sleepSummaries,
    sources.respiratoryRates,
    sources.hrvSamples,
    sources.bloodPressure,
    sources.cardiovascular,
    sources.extendedBodyMeasurements,
  ]);

  return (
    <DebugDataPanel>
      <DataSection title="Daily steps" result={dailySteps}>
        {(response) => <DailyStepsTable items={response.items} />}
      </DataSection>

      <DataSection title="Activity summaries" result={activitySummaries}>
        {(response) => <ActivitySummariesTable items={response.items} />}
      </DataSection>

      <DataSection title="Body measurements" result={bodyMeasurements}>
        {(response) => <BodyMeasurementsTable items={response.items} />}
      </DataSection>

      <DataSection title="Latest heart rate" result={latestHeartRate}>
        {(response) => <HeartRateTable items={response.items} />}
      </DataSection>

      <DataSection title="Sleep nights" result={sleepNights}>
        {(response) => <SleepSessionsTable items={response.items.map((night) => night.session)} />}
      </DataSection>

      <DataSection title="Sleep summaries" result={sleepSummaries}>
        {(response) => <SleepSummariesTable items={response.items} />}
      </DataSection>

      <DataSection title="Respiratory rate" result={respiratoryRates}>
        {(response) => <RespiratoryRateTable items={response.items} />}
      </DataSection>

      <DataSection title="HRV" result={hrvSamples}>
        {(response) => <HrvTable items={response.items} />}
      </DataSection>

      <DataSection title="Blood pressure" result={bloodPressure}>
        {(response) => <BloodPressureTable items={response.items} />}
      </DataSection>

      <DataSection title="Cardiovascular" result={cardiovascular}>
        {(response) => <CardiovascularTable items={response.items} />}
      </DataSection>

      <DataSection title="Extended body metrics" result={extendedBodyMeasurements}>
        {(response) => <ExtendedBodyMeasurementsTable items={response.items} />}
      </DataSection>
    </DebugDataPanel>
  );
}

function isWeightTrendItem(item: BodyMeasurement, toDate: string): boolean {
  const from = Date.parse(`${addUtcDays(toDate, -6)}T00:00:00.000Z`);
  const measuredAt = Date.parse(item.measuredAt);
  return item.metricType === "weight" && !Number.isNaN(measuredAt) && measuredAt >= from;
}

function weightChange(items: BodyMeasurement[]): { value: number; unit: string } | null {
  const sorted = [...items].sort((a, b) => b.measuredAt.localeCompare(a.measuredAt) || b.id - a.id);
  const latest = sorted[0];
  const oldest = sorted[sorted.length - 1];
  if (!latest || !oldest || latest.id === oldest.id || latest.unit !== oldest.unit) {
    return null;
  }

  return {
    value: latest.value - oldest.value,
    unit: latest.unit,
  };
}

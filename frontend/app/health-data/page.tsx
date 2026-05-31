import { Suspense } from "react";
import { DashboardCards } from "@/components/DashboardCards";
import { DataSection } from "@/components/DataSection";
import { DateRangeForm } from "@/components/DateRangeForm";
import { DayOverview } from "@/components/DayOverview";
import { ErrorNotice } from "@/components/ErrorNotice";
import { HealthDataVisualizations } from "@/components/HealthDataVisualizations";
import { JsonDetails } from "@/components/JsonDetails";
import { MetricHighlights } from "@/components/MetricHighlights";
import { PageHeader } from "@/components/PageHeader";
import { StatusBar } from "@/components/StatusBar";
import { ActivitySummariesTable } from "@/components/tables/ActivitySummariesTable";
import { BodyMeasurementsTable } from "@/components/tables/BodyMeasurementsTable";
import { DailyStepsTable } from "@/components/tables/DailyStepsTable";
import { HeartRateTable } from "@/components/tables/HeartRateTable";
import { HrvTable } from "@/components/tables/HrvTable";
import { RespiratoryRateTable } from "@/components/tables/RespiratoryRateTable";
import { SleepSummariesTable } from "@/components/tables/SleepSummariesTable";
import { SleepSessionsTable } from "@/components/tables/SleepSessionsTable";
import { getHealthDataPageData } from "@/lib/aqtHealthApi";
import { addUtcDays, parseDateRange } from "@/lib/dates";
import type { BodyMeasurement } from "@/lib/types";
import { BloodPressureTable } from "@/components/tables/BloodPressureTable";
import { CardiovascularTable } from "@/components/tables/CardiovascularTable";
import { ExtendedBodyMeasurementsTable } from "@/components/tables/ExtendedBodyMeasurementsTable";

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
  const data = await getHealthDataPageData(range.fromDate, range.toDate, range.timezone);
  const healthDay = data.healthDay.ok ? data.healthDay.data : undefined;
  const bodyMeasurements = data.bodyMeasurements.ok ? data.bodyMeasurements.data : undefined;
  const weightTrendItems = bodyMeasurements?.items.filter((item) => isWeightTrendItem(item, range.toDate)) ?? [];
  const weightDelta = weightChange(weightTrendItems);

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

      <StatusBar
        apiBaseUrl={data.apiBaseUrl}
        health={data.health}
        fromDate={range.fromDate}
        toDate={range.toDate}
      />
      {range.warning ? <div className="notice warning">{range.warning}</div> : null}
      <ErrorNotice result={data.health} />
      <ErrorNotice result={data.summary} />
      <ErrorNotice result={data.trends} />
      <ErrorNotice result={data.healthDay} />
      <ErrorNotice result={data.bodyMeasurements} />

      <DashboardCards
        summary={data.summary.ok ? data.summary.data : undefined}
        trends={data.trends.ok ? data.trends.data : undefined}
      />
      <DayOverview
        day={healthDay}
        weightDelta7d={weightDelta?.value}
        weightDelta7dUnit={weightDelta?.unit}
      />

      <MetricHighlights
        latestActivity={data.latestActivity.ok ? data.latestActivity.data : undefined}
        latestSleepSummary={data.latestSleepSummary.ok ? data.latestSleepSummary.data : undefined}
        latestRespiratoryRate={data.latestRespiratoryRate.ok ? data.latestRespiratoryRate.data : undefined}
        latestHrv={data.latestHrv.ok ? data.latestHrv.data : undefined}
        latestBloodPressure={data.latestBloodPressure?.ok ? data.latestBloodPressure.data : undefined}
      />
      <HealthDataVisualizations
        activitySummaries={data.activitySummaries.ok ? data.activitySummaries.data : undefined}
        bodyMeasurements={bodyMeasurements}
        dailySteps={data.dailySteps.ok ? data.dailySteps.data : undefined}
        healthDay={healthDay}
        hrvSamples={data.hrvSamples.ok ? data.hrvSamples.data : undefined}
        latestHeartRate={data.latestHeartRate.ok ? data.latestHeartRate.data : undefined}
        latestSleep={data.latestSleep.ok ? data.latestSleep.data : undefined}
        respiratoryRates={data.respiratoryRates.ok ? data.respiratoryRates.data : undefined}
        sleepSummaries={data.sleepSummaries.ok ? data.sleepSummaries.data : undefined}
        fromDate={range.fromDate}
        toDate={range.toDate}
        timezone={range.timezone}
      />

      <div className="grid">
        <DataSection title="Daily steps" result={data.dailySteps}>
          {(response) => <DailyStepsTable items={response.items} />}
        </DataSection>

        <DataSection title="Activity summaries" result={data.activitySummaries}>
          {(response) => <ActivitySummariesTable items={response.items} />}
        </DataSection>

        <DataSection title="Body measurements" result={data.bodyMeasurements}>
          {(response) => <BodyMeasurementsTable items={response.items} />}
        </DataSection>

        <DataSection title="Latest heart rate" result={data.latestHeartRate}>
          {(response) => <HeartRateTable items={response.items} />}
        </DataSection>

        <DataSection title="Latest sleep" result={data.latestSleep}>
          {(response) => <SleepSessionsTable items={response.items.map((night) => night.session)} />}
        </DataSection>

        <DataSection title="Sleep summaries" result={data.sleepSummaries}>
          {(response) => <SleepSummariesTable items={response.items} />}
        </DataSection>

        <DataSection title="Respiratory rate" result={data.respiratoryRates}>
          {(response) => <RespiratoryRateTable items={response.items} />}
        </DataSection>

        <DataSection title="HRV" result={data.hrvSamples}>
          {(response) => <HrvTable items={response.items} />}
        </DataSection>

        <DataSection title="Blood pressure" result={data.bloodPressure}>
          {(response) => <BloodPressureTable items={response.items} />}
        </DataSection>

        <DataSection title="Cardiovascular" result={data.cardiovascular}>
          {(response) => <CardiovascularTable items={response.items} />}
        </DataSection>

        <DataSection title="Extended body metrics" result={data.extendedBodyMeasurements}>
          {(response) => <ExtendedBodyMeasurementsTable items={response.items} />}
        </DataSection>
      </div>

      <JsonDetails title="Raw day overview response" value={data.healthDay} />
    </>
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

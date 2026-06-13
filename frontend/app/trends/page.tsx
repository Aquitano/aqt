import { ErrorNotice } from "@/components/ErrorNotice";
import { LoadingPulse } from "@/components/motion/LoadingPulse";
import { PageHeader } from "@/components/PageHeader";
import { TrendsBoard } from "@/components/trends/TrendsBoard";
import { TrendsRangeTabs } from "@/components/trends/TrendsRangeTabs";
import { getTrendsPageData } from "@/lib/aqtHealthApi";
import { defaultDateRange } from "@/lib/dates";
import { buildTrendStats } from "@/lib/trends";
import { Suspense } from "react";

const windowOptions = [30, 90, 180, 365] as const;
const defaultWindow = 90;

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function parseWindow(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return (windowOptions as readonly number[]).includes(parsed) ? parsed : defaultWindow;
}

export default async function TrendsPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};
  const days = parseWindow(params.days);
  const toDate = defaultDateRange().toDate;

  return (
    <>
      <PageHeader
        eyebrow="Local health hub"
        title="Trends"
        description="Long-range movement across your metrics, with short- and mid-term change and a focused chart."
        actions={<TrendsRangeTabs days={days} options={windowOptions} />}
      />

      <Suspense key={`${days}-${toDate}`} fallback={<LoadingPulse label="Crunching trends…" />}>
        <TrendsContent days={days} toDate={toDate} />
      </Suspense>
    </>
  );
}

async function TrendsContent({ days, toDate }: { days: number; toDate: string }) {
  const data = await getTrendsPageData(toDate, days);
  const stats = buildTrendStats({
    weight: data.weight.ok ? data.weight.data : undefined,
    steps: data.steps.ok ? data.steps.data : undefined,
    sleep: data.sleep.ok ? data.sleep.data : undefined,
    hrv: data.hrv.ok ? data.hrv.data : undefined,
    activity: data.activity.ok ? data.activity.data : undefined,
    respiratory: data.respiratory.ok ? data.respiratory.data : undefined,
  });

  return (
    <>
      <ErrorNotice result={data.health} />
      <ErrorNotice result={data.weight} />
      <ErrorNotice result={data.steps} />
      <ErrorNotice result={data.sleep} />
      <ErrorNotice result={data.hrv} />
      <ErrorNotice result={data.activity} />
      <ErrorNotice result={data.respiratory} />
      <TrendsBoard stats={stats} />
    </>
  );
}

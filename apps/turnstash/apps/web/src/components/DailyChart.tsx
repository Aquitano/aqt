import type { DayRow } from "@aqt/turnstash-api";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@aqt/ui/components/chart";
import { type ReactNode, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { compact, usd } from "../format";
import { withQuietDays } from "../period";
import { chartRow } from "./ChartRow";
import { Segmented } from "./Segmented";

type Metric = "cost" | "tokens" | "requests";

const metricTabs = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "requests", label: "Requests" },
] as const;

const chartConfig = {
  costUsd: { label: "Cost", color: "var(--primary)" },
  inputTokens: { label: "Input", color: "var(--chart-1)" },
  outputTokens: { label: "Output", color: "var(--chart-4)" },
  cacheReadTokens: { label: "Cache read", color: "var(--chart-5)" },
  requests: { label: "Requests", color: "var(--primary)" },
} satisfies ChartConfig;

type Series = keyof typeof chartConfig;

const seriesOf: Record<Metric, ReadonlyArray<Series>> = {
  cost: ["costUsd"],
  tokens: ["inputTokens", "outputTokens", "cacheReadTokens"],
  requests: ["requests"],
};

const dayOf = (date: string) => new Date(`${date}T00:00:00`);

const dayTick = (date: string) =>
  dayOf(date).toLocaleDateString(undefined, { month: "short", day: "numeric" });

// Recharts types the row behind each tooltip entry as `any`; it is always one of the days.
interface DayEntry {
  readonly payload?: DayRow;
}

const dayTitle = (_label: ReactNode, payload: ReadonlyArray<DayEntry>) => {
  const day = payload[0]?.payload;
  return day === undefined
    ? null
    : dayOf(day.date).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
};

// Recharts finds the hovered row by its axis value, so the axis is keyed by the full date: a
// "Nov 7" label would match last year's Nov 7 first on any range longer than a year.
export const dailyAxisKey = "date" satisfies keyof DayRow;

export const DailyChart = ({ daily }: { readonly daily: ReadonlyArray<DayRow> }) => {
  const [metric, setMetric] = useState<Metric>("cost");
  const money = metric === "cost";
  const series = seriesOf[metric];
  const days = withQuietDays(daily);

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Daily activity</h3>
        <Segmented label="Metric" options={metricTabs} value={metric} onChange={setMetric} />
      </div>
      <ChartContainer
        config={chartConfig}
        className="aspect-auto h-60 w-full pt-3"
        role="img"
        aria-label="Daily totals for the selected period, one bar per day."
      >
        <BarChart data={days} margin={{ left: 0, right: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey={dailyAxisKey}
            tickFormatter={dayTick}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(value: number) => (money ? `$${compact(value)}` : compact(value))}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={dayTitle}
                formatter={chartRow(money ? usd : compact)}
              />
            }
          />
          {series.map((key, index) => (
            <Bar
              key={key}
              dataKey={key}
              name={chartConfig[key].label}
              stackId="day"
              fill={`var(--color-${key})`}
              radius={index === series.length - 1 ? [3, 3, 0, 0] : 0}
            />
          ))}
        </BarChart>
      </ChartContainer>
    </div>
  );
};

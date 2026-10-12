import type { DayRow } from "@aqt/turnstash-api";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@aqt/ui/components/chart";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { compact, usd } from "../format";
import { Card } from "./Card";
import { chartRow } from "./ChartRow";
import { Segmented } from "./Segmented";

type Metric = "cost" | "tokens" | "requests";

const metricTabs = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "requests", label: "Requests" },
] as const;

const chartConfig = {
  costUsd: { label: "Cost", color: "var(--flame)" },
  inputTokens: { label: "Input", color: "var(--chart-1)" },
  outputTokens: { label: "Output", color: "var(--chart-4)" },
  cacheReadTokens: { label: "Cache read", color: "var(--chart-5)" },
  requests: { label: "Requests", color: "var(--flame)" },
} satisfies ChartConfig;

type Series = keyof typeof chartConfig;

const seriesOf: Record<Metric, ReadonlyArray<Series>> = {
  cost: ["costUsd"],
  tokens: ["inputTokens", "outputTokens", "cacheReadTokens"],
  requests: ["requests"],
};

const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export const DailyChart = ({ daily }: { readonly daily: ReadonlyArray<DayRow> }) => {
  const [metric, setMetric] = useState<Metric>("cost");
  const money = metric === "cost";
  const series = seriesOf[metric];
  const days = daily.map((row) => ({ ...row, day: dayLabel(row.date) }));

  return (
    <Card
      title="Daily activity"
      action={<Segmented label="Metric" options={metricTabs} value={metric} onChange={setMetric} />}
    >
      <ChartContainer
        config={chartConfig}
        className="aspect-auto h-70 w-full pt-4"
        role="img"
        aria-label="Daily totals for the selected period, one bar per day."
      >
        <BarChart data={days} margin={{ left: 0, right: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(value: number) => (money ? `$${compact(value)}` : compact(value))}
          />
          <ChartTooltip
            content={<ChartTooltipContent formatter={chartRow(money ? usd : compact)} />}
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
    </Card>
  );
};

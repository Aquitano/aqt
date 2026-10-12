import type { DayRow } from "@aqt/turnstash-api";
import { Tabs, TimeseriesChart } from "@cloudflare/kumo";
import type { TimeseriesData } from "@cloudflare/kumo/components/chart";
import { BarChart, LineChart } from "echarts/charts";
import {
  BrushComponent,
  GridComponent,
  ToolboxComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useState } from "react";

import { compact, usd } from "../format";
import { useTheme } from "../theme";

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  BrushComponent,
  ToolboxComponent,
  CanvasRenderer,
]);

type Metric = "cost" | "tokens" | "requests";

const metricTabs = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "requests", label: "Requests" },
];

const colors = { cost: "#f6821f", input: "#3b82f6", output: "#8b5cf6", cacheRead: "#14b8a6" };

const dayMs = (date: string) => new Date(`${date}T00:00:00`).getTime();

const points = (daily: ReadonlyArray<DayRow>, pick: (day: DayRow) => number): [number, number][] =>
  daily.map((day) => [dayMs(day.date), pick(day)]);

const series = (metric: Metric, daily: ReadonlyArray<DayRow>): TimeseriesData[] => {
  switch (metric) {
    case "cost":
      return [{ name: "Cost", data: points(daily, (day) => day.costUsd), color: colors.cost }];
    case "tokens":
      return [
        { name: "Input", data: points(daily, (day) => day.inputTokens), color: colors.input },
        { name: "Output", data: points(daily, (day) => day.outputTokens), color: colors.output },
        {
          name: "Cache read",
          data: points(daily, (day) => day.cacheReadTokens),
          color: colors.cacheRead,
        },
      ];
    case "requests":
      return [{ name: "Requests", data: points(daily, (day) => day.requests), color: colors.cost }];
  }
};

// One tick per bar overprints as soon as the window is wider than a couple of
// weeks. Cap the count and let ECharts pick which days to name.
const tickCount = (days: number) => Math.max(2, Math.min(8, days));

const isMetric = (value: string): value is Metric =>
  value === "cost" || value === "tokens" || value === "requests";

const tickLabel = (timestamp: number) =>
  new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export const DailyChart = ({ daily }: { readonly daily: ReadonlyArray<DayRow> }) => {
  const { mode } = useTheme();
  const [metric, setMetric] = useState<Metric>("cost");
  const money = metric === "cost";

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Daily activity</h2>
        <Tabs
          size="sm"
          variant="segmented"
          tabs={metricTabs}
          value={metric}
          onValueChange={(value) => {
            if (isMetric(value)) setMetric(value);
          }}
        />
      </div>
      <TimeseriesChart
        echarts={echarts}
        type="bar"
        height={280}
        data={series(metric, daily)}
        isDarkMode={mode === "dark"}
        xAxisTickCount={tickCount(daily.length)}
        xAxisTickFormat={tickLabel}
        yAxisTickFormat={(value) => (money ? `$${compact(value)}` : compact(value))}
        tooltipValueFormat={(value) => (money ? usd(value) : compact(value))}
        tooltipFollowCursor="x"
        ariaDescription="Daily totals for the selected period, one bar per day."
      />
    </section>
  );
};

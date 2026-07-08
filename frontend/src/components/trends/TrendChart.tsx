"use client";

import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatAxisDate, formatChartValue, formatFullDate } from "@/lib/format";
import type { TrendPoint } from "@/lib/trends";
import { useHydrated } from "@/lib/useHydrated";
import styles from "./TrendChart.module.css";

type TrendChartProps = {
  points: TrendPoint[];
  color: string;
  unit: string;
  label: string;
  average?: number | null;
  height?: number;
};

type ChartDatum = {
  date: string;
  label: string;
  value: number;
};

type TooltipEntry = { payload?: ChartDatum };
type TooltipProps = { active?: boolean; payload?: TooltipEntry[] };

export function TrendChart({ points, color, unit, label, average, height = 340 }: TrendChartProps) {
  const gradientId = useId();
  const isClient = useHydrated();
  const data: ChartDatum[] = points.map((point) => ({
    date: point.date,
    label: formatAxisDate(point.date),
    value: point.value,
  }));

  if (data.length === 0) {
    return <div className={styles.empty}>No {label.toLowerCase()} data in this range.</div>;
  }

  return (
    <div className={styles.chart} style={{ height }}>
      {isClient ? (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 12, right: 16, bottom: 6, left: -10 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={color} stopOpacity="0.4" />
                <stop offset="0.85" stopColor={color} stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis
              dataKey="label"
              minTickGap={32}
              tick={{ fill: "var(--fg-dim)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--chart-axis)" }}
            />
            <YAxis
              width={48}
              tick={{ fill: "var(--fg-dim)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              domain={["auto", "auto"]}
            />
            {typeof average === "number" ? (
              <ReferenceLine
                y={average}
                stroke="var(--chart-guide-strong)"
                strokeDasharray="4 4"
                ifOverflow="extendDomain"
              />
            ) : null}
            <Tooltip
              content={<TrendTooltip unit={unit} label={label} color={color} />}
              cursor={{ stroke: "var(--chart-guide)" }}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={color}
              strokeWidth={2.5}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{ r: 5, strokeWidth: 0 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div className={styles.skeleton} aria-hidden="true" />
      )}
    </div>
  );
}

function TrendTooltip({
  active,
  payload,
  unit,
  label,
  color,
}: TooltipProps & { unit: string; label: string; color: string }) {
  if (!active || !payload?.length) return null;
  const datum = payload[0]?.payload;
  if (!datum) return null;
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipDate}>{formatFullDate(datum.date)}</div>
      <div className={styles.tooltipRow}>
        <span className={styles.swatch} style={{ background: color }} />
        <span>{label}</span>
        <strong>{formatChartValue(datum.value, unit)}</strong>
      </div>
    </div>
  );
}

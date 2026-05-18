"use client";

import { Maximize2 } from "lucide-react";
import { useId, useMemo, useState, useSyncExternalStore } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import styles from "./HealthMetricChart.module.css";

export type ChartPointDetail = {
  id: string;
  at: string;
  metricKey: string;
  label: string;
  value: number;
  unit?: string;
  source?: string;
};

export type HealthChartDatum = {
  id: string;
  label: string;
  timestamp: number;
  details: Record<string, ChartPointDetail>;
} & Record<string, string | number | Record<string, ChartPointDetail>>;

export type HealthChartSeries = {
  key: string;
  label: string;
  color: string;
  unit?: string;
};

type HealthMetricChartProps = {
  title: string;
  description?: string;
  series: HealthChartSeries[];
  data: HealthChartDatum[];
  defaultVisibleMetricKeys?: string[];
  height?: number | string;
  onExpand?: (visibleMetricKeys: string[]) => void;
};

type TooltipPayload = {
  dataKey?: string | number;
  value?: unknown;
  color?: string;
  payload?: HealthChartDatum;
};

type TooltipProps = {
  active?: boolean;
  label?: string;
  payload?: TooltipPayload[];
};

export function HealthMetricChart({
  title,
  description,
  series,
  data,
  defaultVisibleMetricKeys,
  height = 280,
  onExpand,
}: HealthMetricChartProps) {
  const titleId = useId();
  const isClient = useClientReady();
  const initialVisible = useMemo(
    () => new Set(defaultVisibleMetricKeys?.length ? defaultVisibleMetricKeys : series.map((item) => item.key)),
    [defaultVisibleMetricKeys, series],
  );
  const [visibleMetricKeys, setVisibleMetricKeys] = useState(initialVisible);
  const visibleSeries = series.filter((item) => visibleMetricKeys.has(item.key));
  const numericValues = visibleSeries.flatMap((item) =>
    data.map((datum) => datum[item.key]).filter((value): value is number => typeof value === "number"),
  );
  const referenceValue = numericValues.length
    ? numericValues.reduce((total, value) => total + value, 0) / numericValues.length
    : undefined;

  function toggleMetric(metricKey: string) {
    setVisibleMetricKeys((current) => {
      const next = new Set(current);
      if (next.has(metricKey) && next.size > 1) {
        next.delete(metricKey);
      } else {
        next.add(metricKey);
      }
      return next;
    });
  }

  if (data.length === 0 || series.length === 0) {
    return (
      <section className={styles.panel} aria-labelledby={titleId}>
        <ChartHeader title={title} titleId={titleId} description={description} onExpand={undefined} />
        <p className={styles.empty}>No chartable data in this range.</p>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <ChartHeader
        title={title}
        titleId={titleId}
        description={description}
        onExpand={onExpand ? () => onExpand(Array.from(visibleMetricKeys)) : undefined}
      />
      <div className={styles.chart} style={{ height }}>
        {isClient ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 10, right: 18, bottom: 8, left: -12 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.07)" vertical={false} />
              <XAxis
                dataKey="label"
                minTickGap={28}
                tick={{ fill: "var(--fg-dim)", fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: "rgba(255,255,255,0.12)" }}
              />
              <YAxis
                width={52}
                tick={{ fill: "var(--fg-dim)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                domain={["auto", "auto"]}
              />
              {referenceValue !== undefined ? (
                <ReferenceLine
                  y={referenceValue}
                  stroke="rgba(255,255,255,0.22)"
                  strokeDasharray="4 4"
                  ifOverflow="extendDomain"
                />
              ) : null}
              <Tooltip content={<ChartTooltip series={series} />} cursor={{ stroke: "rgba(255,255,255,0.16)" }} />
              <Legend
                verticalAlign="bottom"
                content={() => (
                  <div className={styles.legend} aria-label={`${title} metric toggles`}>
                    {series.map((item) => {
                      const active = visibleMetricKeys.has(item.key);
                      return (
                        <button
                          key={item.key}
                          className={active ? styles.legendButtonActive : styles.legendButton}
                          type="button"
                          onClick={() => toggleMetric(item.key)}
                          aria-pressed={active}
                        >
                          <span className={styles.swatch} style={{ background: item.color }} />
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              />
              {visibleSeries.map((item) => (
                <Line
                  key={item.key}
                  type="monotone"
                  dataKey={item.key}
                  name={item.label}
                  stroke={item.color}
                  strokeWidth={2.25}
                  dot={{ r: 2.5, strokeWidth: 1.5 }}
                  activeDot={{ r: 5, strokeWidth: 0 }}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className={styles.chartSkeleton} aria-hidden="true" />
        )}
      </div>
    </section>
  );
}

function useClientReady(): boolean {
  return useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
}

function ChartHeader({
  title,
  titleId,
  description,
  onExpand,
}: {
  title: string;
  titleId: string;
  description?: string;
  onExpand?: () => void;
}) {
  return (
    <div className={styles.header}>
      <div className={styles.titleBlock}>
        <h2 id={titleId}>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {onExpand ? (
        <button className={styles.iconButton} type="button" onClick={onExpand} aria-label={`Expand ${title}`}>
          <Maximize2 size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function ChartTooltip({ active, payload, series }: TooltipProps & { series: HealthChartSeries[] }) {
  if (!active || !payload?.length) return null;
  const datum = payload[0]?.payload;
  if (!datum) return null;
  const seriesByKey = new Map(series.map((item) => [item.key, item]));
  const visiblePayload = payload.filter((item) => typeof item.value === "number");

  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipTitle}>{formatTooltipDate(datum.timestamp)}</div>
      {visiblePayload.map((item) => {
        const metricKey = String(item.dataKey);
        const detail = datum.details[metricKey];
        const metric = seriesByKey.get(metricKey);
        return (
          <div className={styles.tooltipRow} key={metricKey}>
            <span className={styles.tooltipSwatch} style={{ background: metric?.color ?? item.color }} />
            <span>{metric?.label ?? metricKey}</span>
            <strong>{formatValue(Number(item.value), detail?.unit ?? metric?.unit)}</strong>
            {detail?.source ? <small>{detail.source}</small> : null}
          </div>
        );
      })}
    </div>
  );
}

function formatTooltipDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "n/a";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatValue(value: number, unit?: string): string {
  const formatted = new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

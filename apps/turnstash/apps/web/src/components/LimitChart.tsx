import type { LimitHitMarker } from "@aqt/turnstash-api";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@aqt/ui/components/chart";
import { useId, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import { dayTime } from "../format";
import {
  type ChartRow,
  dayTicksOf,
  type DrainBucket,
  type DrainBurst,
  hourMs,
  type LimitJump,
  type LimitSpan,
  type Projection,
} from "../limits-model";

export interface LimitSelection {
  readonly fromMs: number;
  readonly toMs: number;
}

const margin = { top: 22, right: 6, left: 0, bottom: 0 };
const config = {
  recorded: { label: "Recorded" },
  projected: { label: "Projected" },
  rate: { label: "Drain" },
} satisfies ChartConfig;

const tickLabel = (value: number) =>
  new Date(value).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });

const Pill = ({ children }: { readonly children: string }) => (
  <div className="flex justify-end pr-1.5">
    <div className="max-w-full rounded-md bg-popover px-2 py-1 text-right text-xs text-popover-foreground shadow-sm ring-1 ring-foreground/8">
      {children}
    </div>
  </div>
);

const pinnedTooltip = {
  isAnimationActive: false,
  position: { x: 0, y: -2 },
  wrapperStyle: { width: "100%", pointerEvents: "none", zIndex: 5 },
  allowEscapeViewBox: { x: true, y: true },
} as const;

const labelStyle = { fill: "var(--foreground)", fontSize: 11, opacity: 0.78 };
const nowLabel = {
  value: "Now",
  position: "top",
  fill: "var(--muted-foreground)",
  fontSize: 11,
} as const;

const HitMark = ({
  cx,
  cy,
  message,
}: {
  readonly cx?: number;
  readonly cy?: number;
  readonly message: string;
}) => (
  <g>
    <circle cx={cx} cy={cy} r={4} fill="var(--destructive)" stroke="var(--card)" strokeWidth={2} />
    <title>{message}</title>
  </g>
);

const remainingAt = (rows: ReadonlyArray<ChartRow>, t: number): number => {
  let remaining = 0;
  for (const row of rows) {
    if (row.t > t) break;
    remaining = row.recorded ?? row.projected ?? remaining;
  }
  return remaining;
};

export const RemainingChart = ({
  rows,
  span,
  nowMs,
  color,
  projection,
  jumps,
  hits,
  bursts,
  selection,
  onSelect,
  label,
}: {
  readonly rows: ReadonlyArray<ChartRow>;
  readonly span: LimitSpan;
  readonly nowMs: number;
  readonly color: string;
  readonly projection: Projection;
  readonly jumps: ReadonlyArray<LimitJump>;
  readonly hits: ReadonlyArray<LimitHitMarker>;
  readonly bursts: ReadonlyArray<DrainBurst>;
  readonly selection: LimitSelection | null;
  readonly onSelect: (selection: LimitSelection | null) => void;
  readonly label: string;
}) => {
  const id = useId().replaceAll(":", "");
  const [drag, setDrag] = useState<LimitSelection | null>(null);
  const showNow = nowMs >= span.fromMs && nowMs <= span.toMs;
  const timeOf = (state: { readonly activeTooltipIndex?: unknown }) => {
    if (state.activeTooltipIndex == null) return null;
    const row = rows[Number(state.activeTooltipIndex)];
    return row === undefined ? null : Math.min(row.t, nowMs);
  };
  const finish = () => {
    if (drag === null) return;
    const fromMs = Math.min(drag.fromMs, drag.toMs);
    const toMs = Math.max(drag.fromMs, drag.toMs);
    setDrag(null);
    if (toMs - fromMs >= 30 * 60_000) {
      onSelect({ fromMs, toMs });
      return;
    }
    const near = (burst: DrainBurst) => Math.max(burst.fromMs - fromMs, fromMs - burst.toMs, 0);
    const closest = bursts.toSorted((a, b) => near(a) - near(b)).at(0);
    onSelect(closest !== undefined && near(closest) < 2 * hourMs ? closest : null);
  };
  const shaded = drag ?? selection;
  const visibleJumps = [...jumps, ...projection.jumps].filter((jump) => Math.round(jump.gain) >= 1);
  return (
    <ChartContainer
      config={config}
      className="aspect-auto h-72 w-full cursor-crosshair select-none"
      role="img"
      aria-label={label}
    >
      <AreaChart
        data={[...rows]}
        margin={margin}
        onMouseDown={(state) => {
          const t = timeOf(state);
          if (t !== null) setDrag({ fromMs: t, toMs: t });
        }}
        onMouseMove={(state) => {
          const t = timeOf(state);
          if (t !== null) setDrag((current) => (current === null ? null : { ...current, toMs: t }));
        }}
        onMouseUp={finish}
        onMouseLeave={() => setDrag(null)}
      >
        <defs>
          <linearGradient id={`${id}-recorded`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.26} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
          <linearGradient id={`${id}-projected`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.1} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--border)" />
        <XAxis
          dataKey="t"
          type="number"
          domain={[span.fromMs, span.toMs]}
          ticks={[...dayTicksOf(span)]}
          tickFormatter={tickLabel}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={28}
          allowDataOverflow
        />
        <YAxis
          domain={[0, 100]}
          ticks={[0, 50, 100]}
          tickFormatter={(value: number) => `${value}%`}
          tickLine={false}
          axisLine={false}
          width={42}
        />
        <ChartTooltip
          {...pinnedTooltip}
          cursor={{ stroke: "var(--foreground)", strokeOpacity: 0.35 }}
          content={({ active, payload }) => {
            const row: unknown = payload?.[0]?.payload;
            if (!active || !isChartRow(row)) return null;
            const left = row.recorded ?? row.projected;
            if (left === null) return null;
            return (
              <Pill>{`${dayTime(row.t)} · ${Math.round(left)}% left · ${row.recorded === null ? "projected" : "recorded"}`}</Pill>
            );
          }}
        />
        <Area
          dataKey="projected"
          type="linear"
          stroke={color}
          strokeWidth={1.75}
          strokeDasharray="5 4"
          fill={`url(#${id}-projected)`}
          dot={false}
          activeDot={{ r: 3.5, fill: "var(--foreground)", strokeWidth: 0 }}
          isAnimationActive={false}
        />
        <Area
          dataKey="recorded"
          type="stepAfter"
          stroke={color}
          strokeWidth={1.75}
          fill={`url(#${id}-recorded)`}
          dot={false}
          activeDot={{ r: 3.5, fill: "var(--foreground)", strokeWidth: 0 }}
          isAnimationActive={false}
        />
        {shaded !== null && (
          <ReferenceArea
            x1={shaded.fromMs}
            x2={shaded.toMs}
            fill="var(--foreground)"
            fillOpacity={0.08}
            stroke="none"
          />
        )}
        {showNow && <ReferenceLine x={nowMs} stroke="var(--muted-foreground)" label={nowLabel} />}
        {visibleJumps.map((jump) => (
          <ReferenceDot
            key={jump.tMs}
            x={jump.tMs}
            y={100}
            r={0}
            ifOverflow="visible"
            label={{
              value: `+${Math.round(jump.gain)}%`,
              className: visibleJumps.length > 7 ? "hidden lg:block" : "",
              // Beside the jump rather than above it when the "Now" label already sits there.
              position:
                showNow && Math.abs(jump.tMs - nowMs) < (span.toMs - span.fromMs) * 0.04
                  ? "right"
                  : "top",
              offset: 6,
              ...labelStyle,
            }}
          />
        ))}
        {hits.map((hit) => (
          <ReferenceDot
            key={hit.at}
            x={Date.parse(hit.at)}
            y={remainingAt(rows, Date.parse(hit.at))}
            ifOverflow="discard"
            shape={<HitMark message={hit.message} />}
          />
        ))}
        {projection.emptyAtMs !== null &&
          projection.emptyAtMs > nowMs &&
          projection.emptyAtMs <= span.toMs && (
            <ReferenceDot
              x={projection.emptyAtMs}
              y={0}
              r={4.5}
              fill="var(--card)"
              stroke="var(--foreground)"
              strokeWidth={2}
              ifOverflow="visible"
              label={{
                value: `Empty ${dayTime(projection.emptyAtMs)}`,
                position: "top",
                offset: 10,
                fill: "var(--foreground)",
                fontSize: 11,
                fontWeight: 500,
              }}
            />
          )}
      </AreaChart>
    </ChartContainer>
  );
};

const isChartRow = (row: unknown): row is ChartRow =>
  typeof row === "object" && row !== null && "recorded" in row && "projected" in row;

const isBucket = (row: unknown): row is DrainBucket =>
  typeof row === "object" && row !== null && "rate" in row;

export const DrainChart = ({
  buckets,
  bucketMs,
  span,
  nowMs,
  color,
  selection,
  onSelect,
  label,
}: {
  readonly buckets: ReadonlyArray<DrainBucket>;
  readonly bucketMs: number;
  readonly span: LimitSpan;
  readonly nowMs: number;
  readonly color: string;
  readonly selection: LimitSelection | null;
  readonly onSelect: (selection: LimitSelection | null) => void;
  readonly label: string;
}) => (
  <ChartContainer config={config} className="aspect-auto h-72 w-full" role="img" aria-label={label}>
    <BarChart
      data={[...buckets]}
      margin={margin}
      barCategoryGap={1}
      onClick={(state) => {
        if (state.activeTooltipIndex == null) return;
        const bucket = buckets[Number(state.activeTooltipIndex)];
        if (bucket !== undefined && bucket.rate > 0)
          onSelect({ fromMs: bucket.t, toMs: bucket.t + bucketMs });
      }}
    >
      <CartesianGrid stroke="var(--border)" />
      <XAxis
        dataKey={(row: DrainBucket) => row.t + Math.min(bucketMs, span.toMs - row.t) / 2}
        type="number"
        domain={[span.fromMs, span.toMs]}
        ticks={[...dayTicksOf(span)]}
        tickFormatter={tickLabel}
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        minTickGap={28}
      />
      <YAxis
        tickFormatter={(value: number) => `${value}%/h`}
        tickLine={false}
        axisLine={false}
        width={64}
      />
      <ChartTooltip
        {...pinnedTooltip}
        cursor={{ fill: "var(--foreground)", fillOpacity: 0.05 }}
        content={({ active, payload }) => {
          const row: unknown = payload?.[0]?.payload;
          if (!active || !isBucket(row)) return null;
          return (
            <Pill>{`${dayTime(row.t)} to ${dayTime(Math.min(row.t + bucketMs, span.toMs, nowMs))} · ${row.rate.toFixed(1)}%/h drained`}</Pill>
          );
        }}
      />
      <Bar dataKey="rate" fill={color} radius={[3, 3, 0, 0]} isAnimationActive={false}>
        {buckets.map((bucket) => (
          <Cell
            key={bucket.t}
            cursor={bucket.rate > 0 ? "pointer" : "default"}
            fillOpacity={
              selection === null ||
              (bucket.t < selection.toMs && bucket.t + bucketMs > selection.fromMs)
                ? 1
                : 0.35
            }
          />
        ))}
      </Bar>
      {nowMs >= span.fromMs && nowMs <= span.toMs && (
        <ReferenceLine x={nowMs} stroke="var(--muted-foreground)" label={nowLabel} />
      )}
    </BarChart>
  </ChartContainer>
);

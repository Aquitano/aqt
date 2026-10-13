import type { DayRow } from "@aqt/turnstash-api";
import type { CSSVariables } from "@aqt/ui/lib/utils";
import { cn } from "cn";
import { useMemo, useState } from "react";

import { useFilters } from "../filters";
import { usd } from "../format";
import { heatmapDays, heatmapWeeks, ymd } from "../period";
import { Section } from "./Section";

const weekdayLabels = ["Mon", "", "Wed", "", "Fri", "", ""];

// The month strip and every weekday row are separate grids sharing one column template, so the
// columns line up without the cells needing a fixed size. A year of 8px cells needs about 600px;
// phones get smaller cells to keep the current weeks on screen.
const track =
  "grid grid-cols-[22px_repeat(var(--weeks),minmax(4px,1fr))] gap-0.5 sm:grid-cols-[26px_repeat(var(--weeks),minmax(8px,1fr))] sm:gap-[3px]";
const swatch = "aspect-square rounded-[2px]";
const legendSwatch = "size-[11px] flex-none rounded-[2px]";
const noData = "border border-dashed border-border";
const heat = ["bg-heat-0", "bg-heat-1", "bg-heat-2", "bg-heat-3", "bg-heat-4", "bg-heat-5"];

// Five discrete steps rather than a continuous alpha ramp. Continuous shading
// over a dark card composites every cheap day to the same indistinguishable
// brown; five fixed steps stay apart from each other and from the $0 track.
const levels = 5;

interface Cell {
  readonly date: string;
  readonly cost: number;
  readonly requests: number;
  // Before `dataStart` a missing day means "not recorded yet", which is not
  // the same claim as "$0.00 spent".
  readonly noData: boolean;
  readonly future: boolean;
  readonly level: number;
}

// Quantile cut points over the days that had spend. Shading against the single
// peak day is at the mercy of one outlier: with an $80 day in the window every
// ordinary day lands in the bottom step and the grid reads as one flat colour.
const cutPoints = (costs: ReadonlyArray<number>): ReadonlyArray<number> => {
  const sorted = costs.filter((cost) => cost > 0).toSorted((a, b) => a - b);
  if (sorted.length === 0) return [];
  return Array.from({ length: levels - 1 }, (_, index) => {
    const quantile = (index + 1) / levels;
    return sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? 0;
  });
};

const levelOf = (cost: number, cuts: ReadonlyArray<number>): number => {
  if (cost <= 0) return 0;
  return Math.min(
    levels,
    cuts.reduce((level, cut) => (cost >= cut ? level + 1 : level), 1),
  );
};

// One label per month, on the column that actually contains the 1st. Labels
// closer than three columns apart are dropped rather than overprinted.
const monthLabels = (
  weeks: ReadonlyArray<ReadonlyArray<Cell>>,
): ReadonlyArray<{ col: number; label: string }> => {
  const out: Array<{ col: number; label: string }> = [];
  weeks.forEach((week, col) => {
    const first = week.find((cell) => cell.date.endsWith("-01"));
    if (first === undefined) return;
    const last = out[out.length - 1];
    if (last !== undefined && col - last.col < 3) return;
    out.push({
      col,
      label: new Date(`${first.date}T00:00:00`).toLocaleString(undefined, { month: "short" }),
    });
  });
  return out;
};

const describe = (cell: Cell): string => {
  if (cell.noData) return `${cell.date} — no data recorded`;
  if (cell.cost <= 0) return `${cell.date} — nothing spent`;
  return `${cell.date} — ${usd(cell.cost)}, ${cell.requests} requests`;
};

// A tip centred on the first or last weeks runs past the page edge, so near
// either end it hangs off the cell toward the middle instead.
const tipShift = (x: number, width: number): string => {
  if (x < width / 3) return "0%";
  if (x > (width * 2) / 3) return "-100%";
  return "-50%";
};

const buildGrid = (daily: ReadonlyArray<DayRow>, dataStart: string | null, today: Date) => {
  const byDate = new Map(daily.map((day) => [day.date, day]));
  const todayKey = ymd(today);
  const cuts = cutPoints(daily.map((day) => day.costUsd));

  const weeks = heatmapDays(today).map((week) =>
    week.map((key): Cell => {
      const row = byDate.get(key);
      const cost = row?.costUsd ?? 0;
      return {
        date: key,
        cost,
        requests: row?.requests ?? 0,
        noData: row === undefined && (dataStart === null || key < dataStart),
        future: key > todayKey,
        level: levelOf(cost, cuts),
      };
    }),
  );

  return { weeks, months: monthLabels(weeks) };
};

/**
 * Spend calendar for the last year, independent of the selected period. The
 * daily chart answers "how much, over this window"; this answers "which days do
 * I actually work, and where are the gaps".
 */
export const Heatmap = ({
  daily,
  dataStart,
}: {
  readonly daily: ReadonlyArray<DayRow>;
  readonly dataStart: string | null;
}) => {
  const [tip, setTip] = useState<{
    text: string;
    x: number;
    y: number;
    shift: string;
  } | null>(null);
  const { today } = useFilters();
  const firstDay = dataStart === null ? null : ymd(new Date(dataStart));
  const { weeks, months } = useMemo(
    () => buildGrid(daily, firstDay, today),
    [daily, firstDay, today],
  );

  const weeksStyle: CSSVariables = { "--weeks": heatmapWeeks };

  return (
    <Section title="Activity" note={`last ${heatmapWeeks} weeks`}>
      <div
        className="relative mt-3 flex flex-col gap-1"
        style={weeksStyle}
        // Delegated rather than a handler per cell: 364 closures to say the same
        // thing, and the browser's own title tooltip takes a second to appear on
        // a grid whose whole point is a quick scan.
        onMouseOver={(event) => {
          const cell =
            event.target instanceof HTMLElement ? event.target.closest("[role=gridcell]") : null;
          const text = cell?.getAttribute("aria-label");
          if (cell === null || text === null || text === undefined) return setTip(null);
          const box = cell.getBoundingClientRect();
          const host = event.currentTarget.getBoundingClientRect();
          const x = box.left - host.left + box.width / 2;
          setTip({ text, x, y: box.top - host.top, shift: tipShift(x, host.width) });
        }}
        onMouseLeave={() => setTip(null)}
      >
        <div className={cn(track, "h-3 text-[10px] leading-3 text-muted-foreground")} aria-hidden>
          {months.map((month) => (
            <span key={`${month.col}-${month.label}`} style={{ gridColumn: month.col + 2 }}>
              {month.label}
            </span>
          ))}
        </div>

        <div
          className="flex flex-col gap-0.5 sm:gap-[3px]"
          role="grid"
          aria-label={`Daily spend, last ${heatmapWeeks} weeks`}
        >
          {weekdayLabels.map((weekday, index) => (
            <div className={track} role="row" key={weekday === "" ? `row-${index}` : weekday}>
              <span className="self-center text-[10px] text-muted-foreground" role="rowheader">
                {weekday}
              </span>
              {weeks.map((week) => {
                const cell = week[index];
                if (cell === undefined) return null;
                if (cell.future) return <span key={cell.date} className={swatch} role="gridcell" />;
                return (
                  <span
                    key={cell.date}
                    role="gridcell"
                    aria-label={describe(cell)}
                    className={cn(swatch, cell.noData ? noData : heat[cell.level])}
                  />
                );
              })}
            </div>
          ))}
        </div>

        {tip !== null && (
          <span
            className="pointer-events-none absolute z-5 -mt-1.5 rounded-md bg-foreground px-2 py-1 text-[11px] whitespace-nowrap text-background"
            style={{ left: tip.x, top: tip.y, transform: `translate(${tip.shift}, -100%)` }}
            role="tooltip"
          >
            {tip.text}
          </span>
        )}
      </div>

      <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className={cn(legendSwatch, noData)} /> no data
        <span className={cn(legendSwatch, heat[0])} /> $0
        <span className="ml-3 flex items-center gap-1">
          less
          {Array.from({ length: levels }, (_, index) => (
            <span key={index} className={cn(legendSwatch, heat[index + 1])} />
          ))}
          more
        </span>
      </div>
    </Section>
  );
};

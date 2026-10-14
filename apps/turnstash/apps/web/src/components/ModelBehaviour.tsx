import type { ModelComparisonRow } from "@aqt/turnstash-api";
import { cn } from "cn";
import { useState } from "react";

import { int, pct, usd } from "../format";
import { Section } from "./Section";
import { useCollapse } from "./Tables";

const barColour = (modelId: string): string => {
  if (/claude|anthropic/i.test(modelId)) return "bg-primary";
  if (/gpt|codex|openai|(?:^|\/)o\d/i.test(modelId)) return "bg-foreground/80";
  if (/gemini|google/i.test(modelId)) return "bg-chart-1";
  return "bg-chart-5";
};

// Catalog ids end in a release date; it is dropped from the label unless two ids would then read the same.
const labelsOf = (rows: ReadonlyArray<ModelComparisonRow>): ReadonlyMap<string, string> => {
  const short = rows.map((row) => row.modelId.replace(/-\d{8}$/, ""));
  return new Map(
    rows.map((row, index) => {
      const label = short[index] ?? row.modelId;
      return [row.modelId, short.indexOf(label) === short.lastIndexOf(label) ? label : row.modelId];
    }),
  );
};

// Ratios over a handful of turns swing wildly, so they only rank models with enough of them.
const minTurns = 10;
const ratio = (part: number, whole: number): number | null =>
  whole < minTurns ? null : part / whole;

interface Panel {
  readonly title: string;
  readonly note?: string;
  readonly legend?: readonly [strong: string, weak: string];
  readonly empty?: string;
  readonly value: (row: ModelComparisonRow) => number | null;
  readonly strong?: (row: ModelComparisonRow) => number;
  readonly format: (value: number) => string;
  // Shares are drawn against the whole, not against the largest share.
  readonly max?: number;
}

const panels: ReadonlyArray<Panel> = [
  {
    title: "Turns",
    legend: ["edited files", "other"],
    value: (row) => row.turns,
    strong: (row) => row.editTurns,
    format: int,
  },
  { title: "Cost", value: (row) => row.costUsd, format: usd },
  {
    title: "Cost per turn",
    empty: `No model with ${minTurns}+ turns.`,
    value: (row) => ratio(row.costUsd, row.turns),
    format: usd,
  },
  {
    title: "Requests per turn",
    empty: `No model with ${minTurns}+ turns.`,
    value: (row) => ratio(row.requests, row.turns),
    format: (value) => value.toFixed(1),
  },
  {
    title: "Retries per edit turn",
    empty: `No model with ${minTurns}+ edit turns.`,
    value: (row) => ratio(row.retries, row.editTurns),
    format: (value) => value.toFixed(2),
  },
  {
    title: "Cache hit rate",
    note: "cache reads over prompt tokens",
    empty: `No model with ${minTurns}+ turns.`,
    value: (row) => (row.turns < minTurns ? null : row.cacheHitRate),
    format: pct,
    max: 1,
  },
  {
    title: "rg over grep",
    note: "rg turns over rg plus grep turns",
    empty: `No model with ${minTurns}+ turns running rg or grep.`,
    value: (row) => ratio(row.rgTurns, row.rgTurns + row.grepTurns),
    format: pct,
    max: 1,
  },
];

interface Bar {
  readonly modelId: string;
  readonly value: number;
  readonly strong: number;
}

const barsOf = (panel: Panel, rows: ReadonlyArray<ModelComparisonRow>): Array<Bar> =>
  rows
    .flatMap((row) => {
      const value = panel.value(row);
      return value === null || !Number.isFinite(value)
        ? []
        : [{ modelId: row.modelId, value, strong: panel.strong?.(row) ?? value }];
    })
    .toSorted((a, b) => b.value - a.value || a.modelId.localeCompare(b.modelId));

const BarPanel = ({
  panel,
  rows,
  labels,
  hovered,
  onHover,
}: {
  readonly panel: Panel;
  readonly rows: ReadonlyArray<ModelComparisonRow>;
  readonly labels: ReadonlyMap<string, string>;
  readonly hovered: string | null;
  readonly onHover: (modelId: string | null) => void;
}) => {
  const bars = barsOf(panel, rows);
  const collapse = useCollapse(bars);
  const max = panel.max ?? bars[0]?.value ?? 0;
  return (
    <section className="min-w-0">
      <h3 className="mb-2 font-medium">
        {panel.title}
        {panel.note !== undefined && (
          <span className="text-xs font-normal text-muted-foreground"> {panel.note}</span>
        )}
        {panel.legend !== undefined && (
          <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
            <span className="ml-1 size-2 rounded-xs bg-muted-foreground" /> {panel.legend[0]}
            <span className="ml-1 size-2 rounded-xs bg-muted-foreground opacity-40" />{" "}
            {panel.legend[1]}
          </span>
        )}
      </h3>
      {bars.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">{panel.empty}</p>
      ) : (
        <ol className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] gap-x-3 text-xs">
          {collapse.shown.map((bar) => {
            const weak = bar.value - bar.strong;
            const colour = barColour(bar.modelId);
            return (
              <li
                key={bar.modelId}
                className={cn(
                  "col-span-full grid min-h-6 grid-cols-subgrid items-center transition-opacity",
                  hovered !== null && hovered !== bar.modelId && "opacity-30",
                )}
                onPointerEnter={() => onHover(bar.modelId)}
                onPointerLeave={() => onHover(null)}
              >
                <span className="truncate" title={bar.modelId}>
                  {labels.get(bar.modelId) ?? bar.modelId}
                </span>
                <span className="flex" aria-hidden>
                  <span
                    className="flex h-2 min-w-0.5 gap-0.5"
                    style={{ width: `${max > 0 ? Math.min(1, bar.value / max) * 100 : 0}%` }}
                  >
                    {bar.strong > 0 && (
                      <span
                        className={cn("basis-0 rounded-xs", colour)}
                        style={{ flexGrow: bar.strong }}
                      />
                    )}
                    {weak > 0 && (
                      <span
                        className={cn("basis-0 rounded-xs opacity-40", colour)}
                        style={{ flexGrow: weak }}
                      />
                    )}
                  </span>
                </span>
                <span className="text-right">{panel.format(bar.value)}</span>
              </li>
            );
          })}
        </ol>
      )}
      {collapse.toggle}
    </section>
  );
};

export const ModelBehaviour = ({ rows }: { readonly rows: ReadonlyArray<ModelComparisonRow> }) => {
  const [hovered, setHovered] = useState<string | null>(null);
  const labels = labelsOf(rows);
  return (
    <Section title="By model" note="the model that answered the turn first">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-x-10 gap-y-7 pt-3">
        {panels.map((panel) => (
          <BarPanel
            key={panel.title}
            panel={panel}
            rows={rows}
            labels={labels}
            hovered={hovered}
            onHover={setHovered}
          />
        ))}
      </div>
    </Section>
  );
};

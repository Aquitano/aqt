import type { FlowLink } from "@aqt/turnstash-api";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@aqt/ui/components/chart";
import { useId, useMemo } from "react";
import { Layer, Rectangle, Sankey } from "recharts";
import type { SankeyData, SankeyLinkProps, SankeyNodeProps } from "recharts";

import { truncateStart, usd } from "../format";
import { Card } from "./Card";
import { chartRow } from "./ChartRow";

// Enough to see the shape; past this every band is a hairline.
const maxNodesPerSide = 8;

const palette = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"];

type Totals = ReadonlyArray<readonly [string, number]>;

const totalsOf = (links: ReadonlyArray<FlowLink>, key: (link: FlowLink) => string): Totals => {
  const totals = new Map<string, number>();
  for (const link of links) {
    const name = key(link);
    totals.set(name, (totals.get(name) ?? 0) + link.costUsd);
  }
  return [...totals.entries()].toSorted((a, b) => b[1] - a[1]);
};

interface Side {
  readonly names: ReadonlyArray<string>;
  readonly bucket: (name: string) => string;
}

// Fold everything past the top N into one "other" bucket rather than dropping
// it, so the column heights still sum to the total on screen.
const fold = (totals: Totals): Side => {
  const kept = new Set(totals.slice(0, maxNodesPerSide).map(([name]) => name));
  const rest = totals.length - kept.size;
  const otherLabel = `other (${rest})`;
  return {
    names: rest > 0 ? [...kept, otherLabel] : [...kept],
    bucket: (name) => (kept.has(name) ? name : otherLabel),
  };
};

// Nodes and links find their colour by display name, so two truncated labels
// that collide would share one.
const distinct = (taken: Set<string>, label: string): string => {
  let name = label;
  while (taken.has(name)) name += " ";
  taken.add(name);
  return name;
};

const build = (flow: ReadonlyArray<FlowLink>) => {
  const models = fold(totalsOf(flow, (link) => link.modelId));
  const projects = fold(totalsOf(flow, (link) => link.projectKey));

  const taken = new Set<string>();
  const nodes: Array<{ name: string }> = [];
  const colors = new Map<string, string>();
  const indexOf = new Map<string, number>();
  const add = (side: "model" | "project", label: string, position: number) => {
    const name = distinct(taken, truncateStart(label, 30));
    indexOf.set(`${side}:${label}`, nodes.length);
    colors.set(name, `var(${palette[position % palette.length]})`);
    nodes.push({ name });
  };
  models.names.forEach((name, position) => add("model", name, position));
  projects.names.forEach((name, position) => add("project", name, position));

  const merged = new Map<string, number>();
  for (const link of flow) {
    if (link.costUsd <= 0) continue;
    const from = indexOf.get(`model:${models.bucket(link.modelId)}`);
    const to = indexOf.get(`project:${projects.bucket(link.projectKey)}`);
    if (from === undefined || to === undefined) continue;
    const key = `${from}:${to}`;
    merged.set(key, (merged.get(key) ?? 0) + link.costUsd);
  }

  const links: SankeyData["links"] = [...merged].flatMap(([key, value]) => {
    const [from, to] = key.split(":").map(Number);
    return from === undefined || to === undefined ? [] : [{ source: from, target: to, value }];
  });

  return { data: { nodes, links }, colors };
};

type ColorOf = (name: string) => string;

// Sankey calls these as plain functions, once per node and link.
const renderNode =
  (colorOf: ColorOf) =>
  ({ x, y, width, height, payload }: SankeyNodeProps) => (
    <Layer>
      <Rectangle
        x={x}
        y={y}
        width={width}
        height={height}
        fill={colorOf(payload.name)}
        radius={2}
      />
      <text
        x={x + width + 6}
        y={y + height / 2}
        dominantBaseline="middle"
        className="fill-foreground text-xs"
      >
        {payload.name}
      </text>
    </Layer>
  );

const renderLink =
  (colorOf: ColorOf, gradientId: string) =>
  ({
    sourceX,
    targetX,
    sourceY,
    targetY,
    sourceControlX,
    targetControlX,
    linkWidth,
    index,
    payload,
  }: SankeyLinkProps) => (
    <Layer>
      <defs>
        <linearGradient id={`${gradientId}-${index}`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor={colorOf(payload.source.name)} />
          <stop offset="100%" stopColor={colorOf(payload.target.name)} />
        </linearGradient>
      </defs>
      <path
        d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
        fill="none"
        stroke={`url(#${gradientId}-${index})`}
        strokeWidth={Math.max(1, linkWidth)}
        strokeOpacity={0.35}
        className="hover:stroke-opacity-60 transition-[stroke-opacity]"
      />
    </Layer>
  );

/**
 * Where spend flows from models to projects. `byModel` and `byProject` are two
 * independent marginals of this joint distribution — neither can answer which
 * model is expensive in which project.
 */
export const SpendFlow = ({ links }: { readonly links: ReadonlyArray<FlowLink> }) => {
  const { data, colors } = useMemo(() => build(links), [links]);
  const gradientId = useId().replace(/:/g, "");
  const colorOf = (name: string) => colors.get(name) ?? "var(--muted-foreground)";

  if (data.links.length === 0) return null;

  return (
    <Card title="Spend flow" note="model to project">
      <ChartContainer config={{}} className="aspect-auto h-80 w-full pt-3">
        <Sankey
          data={data}
          nodeWidth={8}
          nodePadding={14}
          margin={{ top: 8, right: 160, bottom: 8, left: 8 }}
          node={renderNode(colorOf)}
          link={renderLink(colorOf, gradientId)}
        >
          <ChartTooltip content={<ChartTooltipContent hideLabel formatter={chartRow(usd)} />} />
        </Sankey>
      </ChartContainer>
    </Card>
  );
};

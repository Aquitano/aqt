import type { FlowLink } from "@aqt/turnstash-api";
import { SankeyChart as KumoSankey } from "@cloudflare/kumo";
import type { SankeyLinkData, SankeyNodeData } from "@cloudflare/kumo/components/chart";
import { SankeyChart } from "echarts/charts";
import { TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useMemo } from "react";

import { truncateStart, usd } from "../format";
import { useTheme } from "../theme";

echarts.use([SankeyChart, TooltipComponent, CanvasRenderer]);

// Enough to see the shape; past this every band is a hairline.
const maxNodesPerSide = 8;

type Totals = ReadonlyArray<readonly [string, number]>;

const totalsOf = (links: ReadonlyArray<FlowLink>, key: (link: FlowLink) => string): Totals => {
  const totals = new Map<string, number>();
  for (const link of links) {
    const name = key(link);
    totals.set(name, (totals.get(name) ?? 0) + link.costUsd);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
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

// ECharts identifies sankey nodes by their display name, so two truncated
// labels that collide would merge into one node.
const distinct = (taken: Set<string>, label: string): string => {
  let name = label;
  while (taken.has(name)) name += " ";
  taken.add(name);
  return name;
};

const build = (flow: ReadonlyArray<FlowLink>) => {
  const models = fold(totalsOf(flow, (link) => link.modelId));
  const projects = fold(totalsOf(flow, (link) => link.projectKey));

  const taken = new Set<string>();
  const nodes: SankeyNodeData[] = [];
  const indexOf = new Map<string, number>();
  const add = (side: "model" | "project", label: string) => {
    indexOf.set(`${side}:${label}`, nodes.length);
    nodes.push({ name: distinct(taken, truncateStart(label, 30)) });
  };
  for (const name of models.names) add("model", name);
  for (const name of projects.names) add("project", name);

  const merged = new Map<string, number>();
  for (const link of flow) {
    if (link.costUsd <= 0) continue;
    const from = indexOf.get(`model:${models.bucket(link.modelId)}`);
    const to = indexOf.get(`project:${projects.bucket(link.projectKey)}`);
    if (from === undefined || to === undefined) continue;
    const key = `${from}:${to}`;
    merged.set(key, (merged.get(key) ?? 0) + link.costUsd);
  }

  const links: SankeyLinkData[] = [...merged].flatMap(([key, value]) => {
    const [from, to] = key.split(":").map(Number);
    return from === undefined || to === undefined ? [] : [{ source: from, target: to, value }];
  });

  return { nodes, links };
};

/**
 * Where spend flows from models to projects. `byModel` and `byProject` are two
 * independent marginals of this joint distribution — neither can answer which
 * model is expensive in which project.
 */
export const SpendFlow = ({ links }: { readonly links: ReadonlyArray<FlowLink> }) => {
  const { mode } = useTheme();
  const flow = useMemo(() => build(links), [links]);

  if (flow.links.length === 0) return null;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Spend flow</h2>
        <span className="card-note">model to project</span>
      </div>
      <KumoSankey
        echarts={echarts}
        nodes={flow.nodes}
        links={flow.links}
        height={320}
        isDarkMode={mode === "dark"}
        formatValue={usd}
        linkColor="gradient"
      />
    </section>
  );
};

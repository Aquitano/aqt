import { providerLabels } from "@aqt/turnstash-api";
import type { MachineSummary, ModelRow, ProjectRow, ProviderRow } from "@aqt/turnstash-api";
import { Badge, Button } from "@cloudflare/kumo";
import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";

import { compact, dateTime, hoursSince, int, relativeTime, usd } from "../format";
import { Card } from "./Card";
import { ShareCell, shareOf, totalCost } from "./ShareCell";
import { SortHeader, useSort } from "./Sort";

export const routeLabel = (route: string): string => route.charAt(0).toUpperCase() + route.slice(1);

const collapsedRows = 8;

export const useCollapse = <A,>(rows: ReadonlyArray<A>) => {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded || rows.length <= collapsedRows + 2 ? rows : rows.slice(0, collapsedRows);
  const toggle =
    shown.length === rows.length && !expanded ? null : (
      <div className="table-foot">
        <Button size="xs" variant="ghost" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show fewer" : `Show all ${rows.length}`}
        </Button>
      </div>
    );
  return { shown, toggle };
};

type ModelKey = "modelId" | "requests" | "inputTokens" | "outputTokens" | "costUsd";

export const ModelsTable = ({ rows }: { readonly rows: ReadonlyArray<ModelRow> }) => {
  const total = totalCost(rows);
  const pick = useCallback((row: ModelRow, key: ModelKey) => row[key], []);
  const { sorted, sort, toggle } = useSort<ModelRow, ModelKey>(
    rows,
    { key: "costUsd", direction: "desc" },
    pick,
  );
  const collapse = useCollapse(sorted);
  return (
    <Card title="By model" note={`${rows.length} models`}>
      <table className="data-table">
        <thead>
          <tr>
            <SortHeader label="Model" column="modelId" sort={sort} onToggle={toggle} />
            <SortHeader label="Requests" column="requests" sort={sort} onToggle={toggle} numeric />
            <SortHeader label="In" column="inputTokens" sort={sort} onToggle={toggle} numeric />
            <SortHeader label="Out" column="outputTokens" sort={sort} onToggle={toggle} numeric />
            <SortHeader label="Cost" column="costUsd" sort={sort} onToggle={toggle} numeric />
          </tr>
        </thead>
        <tbody>
          {collapse.shown.map((row) => (
            <tr key={`${row.modelId}:${row.route ?? ""}`}>
              <ShareCell
                label={row.modelId}
                share={shareOf(row.costUsd, total)}
                sub={row.route === null ? null : routeLabel(row.route)}
              />
              <td className="num">{int(row.requests)}</td>
              <td className="num" title={int(row.inputTokens)}>
                {compact(row.inputTokens)}
              </td>
              <td className="num" title={int(row.outputTokens)}>
                {compact(row.outputTokens)}
              </td>
              <td className="num">{usd(row.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {collapse.toggle}
    </Card>
  );
};

type ProjectKey = "projectKey" | "conversations" | "requests" | "costUsd";

export const ProjectsTable = ({ rows }: { readonly rows: ReadonlyArray<ProjectRow> }) => {
  const total = totalCost(rows);
  const pick = useCallback((row: ProjectRow, key: ProjectKey) => row[key], []);
  const { sorted, sort, toggle } = useSort<ProjectRow, ProjectKey>(
    rows,
    { key: "costUsd", direction: "desc" },
    pick,
  );
  const collapse = useCollapse(sorted);
  return (
    <Card title="By project" note={`${rows.length} projects`}>
      <table className="data-table">
        <thead>
          <tr>
            <SortHeader label="Project" column="projectKey" sort={sort} onToggle={toggle} />
            <SortHeader
              label="Conversations"
              column="conversations"
              sort={sort}
              onToggle={toggle}
              numeric
            />
            <SortHeader label="Requests" column="requests" sort={sort} onToggle={toggle} numeric />
            <SortHeader label="Cost" column="costUsd" sort={sort} onToggle={toggle} numeric />
          </tr>
        </thead>
        <tbody>
          {collapse.shown.map((row) => (
            <tr key={row.projectKey}>
              <ShareCell
                label={
                  <Link
                    to="/projects/$key"
                    params={{ key: row.projectKey }}
                    title={row.projectPath ?? row.projectKey}
                  >
                    {row.projectKey}
                  </Link>
                }
                share={shareOf(row.costUsd, total)}
              />
              <td className="num">{int(row.conversations)}</td>
              <td className="num">{int(row.requests)}</td>
              <td className="num">{usd(row.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {collapse.toggle}
    </Card>
  );
};

export const ProvidersTable = ({ rows }: { readonly rows: ReadonlyArray<ProviderRow> }) => {
  const total = totalCost(rows);
  return (
    <Card title="By provider" note={`${rows.length} providers`}>
      <table className="data-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th className="num">Conversations</th>
            <th className="num">Requests</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.provider}>
              <ShareCell label={providerLabels[row.provider]} share={shareOf(row.costUsd, total)} />
              <td className="num">{int(row.conversations)}</td>
              <td className="num">{int(row.requests)}</td>
              <td className="num">{usd(row.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
};

const Freshness = ({ lastSeenAt }: { readonly lastSeenAt: string | null }) => {
  const hours = hoursSince(lastSeenAt);
  return (
    <Badge
      variant={hours <= 24 ? "success" : hours <= 24 * 7 ? "warning" : "error"}
      appearance="dot"
    >
      {relativeTime(lastSeenAt)}
    </Badge>
  );
};

export const MachinesTable = ({
  rows,
  title,
  note,
  platform = false,
  enrolled = false,
  conversations = false,
  agent,
}: {
  readonly rows: ReadonlyArray<MachineSummary>;
  readonly title: string;
  readonly note: ReactNode;
  readonly platform?: boolean;
  readonly enrolled?: boolean;
  readonly conversations?: boolean;
  readonly agent?: "column" | "inline";
}) => (
  <Card title={title} note={note}>
    <table className="data-table">
      <thead>
        <tr>
          <th>Machine</th>
          {platform && <th>Platform</th>}
          <th>Last sync</th>
          {enrolled && <th>Enrolled</th>}
          {agent === "column" && <th className="num">Agent</th>}
          {conversations && <th className="num">Conversations</th>}
          <th className="num">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((machine) => {
          const platformName = `${machine.os} · ${machine.arch}`;
          return (
            <tr key={machine.id}>
              <td className="primary" title={platform ? undefined : platformName}>
                <Link to="/machines/$id" params={{ id: machine.id }}>
                  {machine.name}
                </Link>
                {agent === "inline" && (
                  <span className="muted"> {machine.agentVersion ?? "no agent version"}</span>
                )}
              </td>
              {platform && (
                <td>
                  <Badge variant="neutral">{platformName}</Badge>
                </td>
              )}
              <td>
                <Freshness lastSeenAt={machine.lastSeenAt} />
              </td>
              {enrolled && <td>{dateTime(machine.enrolledAt)}</td>}
              {agent === "column" && (
                <td className="num muted">{machine.agentVersion ?? "none"}</td>
              )}
              {conversations && <td className="num">{int(machine.conversations)}</td>}
              <td className="num">{usd(machine.costUsd)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </Card>
);

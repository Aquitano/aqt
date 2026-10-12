import { providerLabels } from "@aqt/turnstash-api";
import type { MachineSummary, ModelRow, ProjectRow, ProviderRow } from "@aqt/turnstash-api";
import { Badge } from "@aqt/ui/components/badge";
import { Button } from "@aqt/ui/components/button";
import { TableBody, TableHeader, TableRow } from "@aqt/ui/components/table";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";

import { compact, dateTime, hoursSince, int, relativeTime, usd } from "../format";
import { Card } from "./Card";
import { DataTable, PrimaryTd, Td, Th } from "./DataTable";
import { ShareCell, shareOf, totalCost } from "./ShareCell";
import { SortHeader, useSort } from "./Sort";

export const routeLabel = (route: string): string => route.charAt(0).toUpperCase() + route.slice(1);

const collapsedRows = 8;

export const useCollapse = <A,>(rows: ReadonlyArray<A>) => {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded || rows.length <= collapsedRows + 2 ? rows : rows.slice(0, collapsedRows);
  const toggle =
    shown.length === rows.length && !expanded ? null : (
      <div className="flex items-center gap-2 pt-2">
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
      <DataTable>
        <TableHeader>
          <TableRow>
            <SortHeader label="Model" column="modelId" sort={sort} onToggle={toggle} />
            <SortHeader label="Requests" column="requests" sort={sort} onToggle={toggle} numeric />
            <SortHeader label="In" column="inputTokens" sort={sort} onToggle={toggle} numeric />
            <SortHeader label="Out" column="outputTokens" sort={sort} onToggle={toggle} numeric />
            <SortHeader label="Cost" column="costUsd" sort={sort} onToggle={toggle} numeric />
          </TableRow>
        </TableHeader>
        <TableBody>
          {collapse.shown.map((row) => (
            <TableRow key={`${row.modelId}:${row.route ?? ""}`}>
              <ShareCell
                label={row.modelId}
                share={shareOf(row.costUsd, total)}
                sub={row.route === null ? null : routeLabel(row.route)}
              />
              <Td numeric>{int(row.requests)}</Td>
              <Td numeric title={int(row.inputTokens)}>
                {compact(row.inputTokens)}
              </Td>
              <Td numeric title={int(row.outputTokens)}>
                {compact(row.outputTokens)}
              </Td>
              <Td numeric>{usd(row.costUsd)}</Td>
            </TableRow>
          ))}
        </TableBody>
      </DataTable>
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
      <DataTable>
        <TableHeader>
          <TableRow>
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
          </TableRow>
        </TableHeader>
        <TableBody>
          {collapse.shown.map((row) => (
            <TableRow key={row.projectKey}>
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
              <Td numeric>{int(row.conversations)}</Td>
              <Td numeric>{int(row.requests)}</Td>
              <Td numeric>{usd(row.costUsd)}</Td>
            </TableRow>
          ))}
        </TableBody>
      </DataTable>
      {collapse.toggle}
    </Card>
  );
};

export const ProvidersTable = ({ rows }: { readonly rows: ReadonlyArray<ProviderRow> }) => {
  const total = totalCost(rows);
  return (
    <Card title="By provider" note={`${rows.length} providers`}>
      <DataTable>
        <TableHeader>
          <TableRow>
            <Th>Provider</Th>
            <Th numeric>Conversations</Th>
            <Th numeric>Requests</Th>
            <Th numeric>Cost</Th>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.provider}>
              <ShareCell label={providerLabels[row.provider]} share={shareOf(row.costUsd, total)} />
              <Td numeric>{int(row.conversations)}</Td>
              <Td numeric>{int(row.requests)}</Td>
              <Td numeric>{usd(row.costUsd)}</Td>
            </TableRow>
          ))}
        </TableBody>
      </DataTable>
    </Card>
  );
};

const Freshness = ({ lastSeenAt }: { readonly lastSeenAt: string | null }) => {
  const hours = hoursSince(lastSeenAt);
  return (
    <Badge variant="outline">
      <span
        className={cn(
          "size-1.5 rounded-full",
          hours <= 24 ? "bg-success" : hours <= 24 * 7 ? "bg-warning" : "bg-destructive",
        )}
      />
      {relativeTime(lastSeenAt)}
    </Badge>
  );
};

export const MachinesTable = ({
  rows,
  title,
  note,
  action,
  platform = false,
  enrolled = false,
  conversations = false,
  agent,
}: {
  readonly rows: ReadonlyArray<MachineSummary>;
  readonly title: string;
  readonly note?: ReactNode;
  readonly action?: ReactNode;
  readonly platform?: boolean;
  readonly enrolled?: boolean;
  readonly conversations?: boolean;
  readonly agent?: "column" | "inline";
}) => (
  <Card title={title} note={note} action={action}>
    <DataTable>
      <TableHeader>
        <TableRow>
          <Th>Machine</Th>
          {platform && <Th>Platform</Th>}
          <Th>Last sync</Th>
          {enrolled && <Th>Enrolled</Th>}
          {agent === "column" && <Th numeric>Agent</Th>}
          {conversations && <Th numeric>Conversations</Th>}
          <Th numeric>Cost</Th>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((machine) => {
          const platformName = `${machine.os} · ${machine.arch}`;
          return (
            <TableRow key={machine.id}>
              <PrimaryTd title={platform ? undefined : platformName}>
                <Link to="/machines/$id" params={{ id: machine.id }}>
                  {machine.name}
                </Link>
                {agent === "inline" && (
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    {machine.agentVersion ?? "no agent version"}
                  </span>
                )}
              </PrimaryTd>
              {platform && (
                <Td>
                  <Badge variant="secondary">{platformName}</Badge>
                </Td>
              )}
              <Td>
                <Freshness lastSeenAt={machine.lastSeenAt} />
              </Td>
              {enrolled && <Td>{dateTime(machine.enrolledAt)}</Td>}
              {agent === "column" && (
                <Td numeric className="text-xs text-muted-foreground">
                  {machine.agentVersion ?? "none"}
                </Td>
              )}
              {conversations && <Td numeric>{int(machine.conversations)}</Td>}
              <Td numeric>{usd(machine.costUsd)}</Td>
            </TableRow>
          );
        })}
      </TableBody>
    </DataTable>
  </Card>
);

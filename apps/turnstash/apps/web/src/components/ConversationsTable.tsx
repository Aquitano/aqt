import type { ConversationSummary } from "@aqt/turnstash-api";
import { TableBody, TableHeader, TableRow } from "@aqt/ui/components/table";
import { Link } from "@tanstack/react-router";
import { useCallback } from "react";

import { dateTime, int, shortId, usd } from "../format";
import { DataTable, PrimaryTd, Td } from "./DataTable";
import { ProviderBadge } from "./ProviderBadge";
import { SortHeader, useSort } from "./Sort";

export const conversationLabel = (row: ConversationSummary): string =>
  row.title ?? row.projectKey ?? shortId(row.conversationKey, 12);

type Key = "title" | "provider" | "startedAt" | "messageCount" | "requestCount" | "costUsd";

export const ConversationsTable = ({
  rows,
  showShare = false,
}: {
  readonly rows: ReadonlyArray<ConversationSummary>;
  readonly showShare?: boolean;
}) => {
  const peak = rows.reduce((max, row) => Math.max(max, row.costUsd), 0);
  const pick = useCallback(
    (row: ConversationSummary, key: Key) => (key === "title" ? conversationLabel(row) : row[key]),
    [],
  );
  const { sorted, sort, toggle } = useSort<ConversationSummary, Key>(
    rows,
    { key: showShare ? "costUsd" : "startedAt", direction: "desc" },
    pick,
  );

  return (
    <DataTable>
      <TableHeader>
        <TableRow>
          <SortHeader label="Conversation" column="title" sort={sort} onToggle={toggle} />
          <SortHeader label="Provider" column="provider" sort={sort} onToggle={toggle} />
          <SortHeader label="Started" column="startedAt" sort={sort} onToggle={toggle} />
          <SortHeader
            label="Messages"
            column="messageCount"
            sort={sort}
            onToggle={toggle}
            numeric
          />
          <SortHeader
            label="Requests"
            column="requestCount"
            sort={sort}
            onToggle={toggle}
            numeric
          />
          <SortHeader label="Cost" column="costUsd" sort={sort} onToggle={toggle} numeric />
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((row) => (
          <TableRow key={row.id}>
            <PrimaryTd title={row.projectPath ?? row.conversationKey}>
              <Link to="/conversations/$id" params={{ id: row.id }}>
                {conversationLabel(row)}
              </Link>
              {row.title !== null && row.projectKey !== null && (
                <span className="text-xs text-muted-foreground"> {row.projectKey}</span>
              )}
              {showShare && (
                <span className="mt-1 block h-0.5 overflow-hidden bg-muted">
                  <span
                    className="block h-full bg-flame"
                    style={{ width: `${peak > 0 ? (row.costUsd / peak) * 100 : 0}%` }}
                  />
                </span>
              )}
            </PrimaryTd>
            <Td>
              <ProviderBadge provider={row.provider} />
            </Td>
            <Td title={row.startedAt}>{dateTime(row.startedAt)}</Td>
            <Td numeric>{int(row.messageCount)}</Td>
            <Td numeric>{int(row.requestCount)}</Td>
            <Td numeric>{usd(row.costUsd)}</Td>
          </TableRow>
        ))}
      </TableBody>
    </DataTable>
  );
};

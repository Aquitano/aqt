import type { ConversationSummary } from "@aqt/turnstash-api";
import { Link } from "@tanstack/react-router";
import { useCallback } from "react";

import { dateTime, int, shortId, usd } from "../format";
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
    <table className="data-table">
      <thead>
        <tr>
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
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={row.id}>
            <td className="primary" title={row.projectPath ?? row.conversationKey}>
              <Link to="/conversations/$id" params={{ id: row.id }}>
                {conversationLabel(row)}
              </Link>
              {row.title !== null && row.projectKey !== null && (
                <span className="muted"> {row.projectKey}</span>
              )}
              {showShare && (
                <span className="share">
                  <i style={{ width: `${peak > 0 ? (row.costUsd / peak) * 100 : 0}%` }} />
                </span>
              )}
            </td>
            <td>
              <ProviderBadge provider={row.provider} />
            </td>
            <td title={row.startedAt}>{dateTime(row.startedAt)}</td>
            <td className="num">{int(row.messageCount)}</td>
            <td className="num">{int(row.requestCount)}</td>
            <td className="num">{usd(row.costUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

import type { CacheBreak, CacheBreakReport } from "@aqt/turnstash-api";
import { TableBody, TableHeader, TableRow } from "@aqt/ui/components/table";
import { Link } from "@tanstack/react-router";

import { compact, dateTime, int, usd } from "../format";
import { DataTable, PrimaryTd, Td, Th } from "./DataTable";
import { Section } from "./Section";
import { useCollapse } from "./Tables";

const idleText = (row: CacheBreak): string => {
  const minutes = Math.round(row.idleMinutes);
  if (minutes < 1) return "right after the last request";
  return minutes < 90 ? `after ${minutes} min` : `after ${Math.round(minutes / 60)} h`;
};

export const CacheBreaks = ({ report }: { readonly report: CacheBreakReport }) => {
  const collapse = useCollapse(report.rows);
  return (
    <Section
      title="Cache breaks"
      note={
        report.breaks === 0
          ? "no conversation rewrote its cache in this period"
          : `${int(report.breaks)} ${report.breaks === 1 ? "rewrite" : "rewrites"} cost ${usd(report.rewriteCostUsd)}, ${int(report.withinLifetime)} while alive, ${int(report.breaks - report.withinLifetime - report.unknownLifetime)} after expiry${report.unknownLifetime > 0 ? `, ${int(report.unknownLifetime)} with unknown lifetime` : ""}`
      }
    >
      {report.breaks === 0 ? (
        <p className="text-muted-foreground">
          A cache break is a request that writes most of what the previous request of its
          conversation had cached, instead of reading it.
        </p>
      ) : (
        <>
          <p className="mb-2 text-xs text-muted-foreground">
            Requests that wrote most of their conversation's cache instead of reading it. A rewrite
            while the cache was alive points at a changed prefix or a switched account, and
            compacting a conversation looks the same.
          </p>
          <DataTable>
            <TableHeader>
              <TableRow>
                <Th>Conversation</Th>
                <Th secondary>When</Th>
                <Th>Cache</Th>
                <Th numeric secondary>
                  Written
                </Th>
                <Th numeric secondary>
                  Read
                </Th>
                <Th numeric>Rewrite cost</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {collapse.shown.map((row) => (
                <TableRow key={row.requestId}>
                  <PrimaryTd title={row.modelId}>
                    <Link
                      to="/conversations/$id"
                      params={{ id: row.conversationId }}
                      search={row.messageKey === null ? {} : { message: row.messageKey }}
                    >
                      {row.conversationTitle ?? row.modelId}
                    </Link>
                  </PrimaryTd>
                  <Td secondary title={row.requestedAt}>
                    {dateTime(row.requestedAt)}
                  </Td>
                  <Td>
                    {row.withinLifetime === null
                      ? "Lifetime unknown, "
                      : row.withinLifetime
                        ? "Still alive, "
                        : "Expired, "}
                    <span className="text-muted-foreground">{idleText(row)}</span>
                  </Td>
                  <Td numeric secondary title={int(row.cacheWriteTokens)}>
                    {compact(row.cacheWriteTokens)}
                  </Td>
                  <Td numeric secondary title={int(row.cacheReadTokens)}>
                    {compact(row.cacheReadTokens)}
                  </Td>
                  <Td numeric>{usd(row.rewriteCostUsd)}</Td>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
          {collapse.toggle}
        </>
      )}
    </Section>
  );
};

import type { TimelineEvent } from "@aqt/turnstash-api";
import { Badge, Button } from "@cloudflare/kumo";
import { Chart } from "@cloudflare/kumo/components/chart";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { BarChart, LineChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { Match } from "effect";
import { useMemo, useState } from "react";

import { isTimelineChanged } from "../api";
import { dateTime, int, preciseUsd } from "../format";
import { timelinePagesQuery } from "../queries";
import { useTheme } from "../theme";
import { Pending, RequestFailure } from "./Async";

echarts.use([
  BarChart,
  LineChart,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

const eventLabel = (event: TimelineEvent) =>
  event.kind === "request" ? `Request · ${event.modelId}` : `Tool · ${event.toolName}`;

const eventColor = (event: TimelineEvent) => {
  if (event.kind === "request") return event.costUsd === null ? "#8b5cf6" : "#f6821f";
  if (event.toolStatus === "error") return "#ef4444";
  return event.toolStatus === "ok" ? "#14b8a6" : "#9ca3af";
};

const toolStatusLabel = (event: TimelineEvent) =>
  Match.value(event.toolStatus).pipe(
    Match.when("error", () => "Failed"),
    Match.when("ok", () => "OK"),
    Match.orElse(() => "Status unknown"),
  );

export const SessionTimeline = ({
  conversationId,
  onInspect,
}: {
  readonly conversationId: string;
  readonly onInspect: (requestId: string) => void;
}) => {
  const pages = useInfiniteQuery(timelinePagesQuery(conversationId));
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { mode } = useTheme();
  const [unlinkedEvent, setUnlinkedEvent] = useState<string | null>(null);
  const events = useMemo(
    () => (pages.data?.pages ?? []).flatMap((page) => page.items),
    [pages.data],
  );
  const options = useMemo(
    () => ({
      animation: false,
      backgroundColor: "transparent",
      legend: { data: ["Cumulative priced cost", "Request cost"] },
      grid: { left: 70, right: 24, top: 40, bottom: 80 },
      tooltip: { trigger: "item" as const, renderMode: "richText" as const },
      xAxis: {
        type: "category" as const,
        name: "Event order",
        data: events.map((_, index) => String(index + 1)),
      },
      yAxis: {
        type: "value" as const,
        min: 0,
        axisLabel: { formatter: (value: number) => preciseUsd(value) },
      },
      dataZoom: [{ type: "slider" as const, start: 0, end: 100 }],
      series: [
        {
          name: "Cumulative priced cost",
          type: "line" as const,
          step: "end" as const,
          showSymbol: true,
          symbolSize: 8,
          lineStyle: { color: "#f6821f" },
          data: events.map((event) => ({
            name: eventLabel(event),
            value: event.cumulativeCostUsd,
            itemStyle: { color: eventColor(event) },
          })),
        },
        {
          name: "Request cost",
          type: "bar" as const,
          itemStyle: { color: "#3b82f6" },
          data: events.map((event) => ({
            name: eventLabel(event),
            value: event.kind === "request" ? event.costUsd : null,
          })),
        },
      ],
    }),
    [events],
  );

  if (pages.isPending) return <Pending />;
  if (pages.data === undefined)
    return (
      <div className="stack">
        <RequestFailure error={pages.error ?? new Error("Could not load the timeline.")} />
        <Button size="sm" onClick={() => void pages.refetch()}>
          Retry timeline
        </Button>
      </div>
    );
  const timelineChanged = pages.error !== null && isTimelineChanged(pages.error);
  const summary = pages.data.pages.at(-1);
  if (summary === undefined || summary.totalEvents === 0)
    return <p className="muted">No model requests or tool executions recorded.</p>;

  return (
    <div className="stack">
      <p className="card-note">
        {preciseUsd(summary.pricedCostUsd)} priced request cost · {int(summary.unpricedRequests)}{" "}
        unpriced requests · {int(events.length)} of {int(summary.totalEvents)} events loaded. Tool
        events add no cost. Unknown times appear last. The chart uses event order, not elapsed time.
      </p>
      <div
        role="img"
        aria-label="Cumulative priced request cost and individual request costs in event order. Use the event table below for transcript links and request inspection."
      >
        <Chart
          echarts={echarts}
          options={options}
          height={280}
          isDarkMode={mode === "dark"}
          onEvents={{
            click: (params) => {
              const event = params.dataIndex === undefined ? undefined : events[params.dataIndex];
              if (event === undefined) return;
              if (event.messageKey === null) setUnlinkedEvent(eventLabel(event));
              else
                void navigate({
                  to: "/conversations/$id",
                  params: { id: conversationId },
                  search: { message: event.messageKey },
                });
            },
          }}
        />
      </div>
      {unlinkedEvent !== null && (
        <p role="status" className="muted">
          {unlinkedEvent}: no associated transcript message is recorded.
        </p>
      )}
      <div className="timeline-table-scroll">
        <table className="data-table">
          <caption className="sr-only">
            Session events in chronological order. Equal timestamps use event type and source key.
            Events without times appear last.
          </caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Event</th>
              <th scope="col" className="num">
                Request cost
              </th>
              <th scope="col" className="num">
                Cumulative priced
              </th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.eventKey}>
                <td title={event.timestamp ?? "No timestamp recorded"}>
                  {event.timestamp === null ? "Unknown time" : dateTime(event.timestamp)}
                </td>
                <td>
                  <span>{eventLabel(event)}</span>
                  {event.previousModelId !== null && (
                    <div className="muted">Model changed from {event.previousModelId}</div>
                  )}
                  {event.kind === "tool" && (
                    <div>
                      <Badge variant={event.toolStatus === "error" ? "error" : "neutral"}>
                        {toolStatusLabel(event)}
                      </Badge>
                    </div>
                  )}
                </td>
                <td className="num" title={event.unpricedReason ?? undefined}>
                  {event.kind === "tool"
                    ? "No separate cost"
                    : event.costUsd === null
                      ? "Unpriced"
                      : preciseUsd(event.costUsd)}
                </td>
                <td className="num">
                  {preciseUsd(event.cumulativeCostUsd)}
                  {event.cumulativeUnpricedRequests > 0 && (
                    <div className="muted">+ {int(event.cumulativeUnpricedRequests)} unpriced</div>
                  )}
                </td>
                <td>
                  <div className="row">
                    {event.messageKey === null ? (
                      <span className="muted">No transcript association</span>
                    ) : (
                      <Link
                        to="/conversations/$id"
                        params={{ id: conversationId }}
                        search={{ message: event.messageKey }}
                      >
                        Open transcript
                      </Link>
                    )}
                    {event.requestId !== null && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (event.requestId !== null) onInspect(event.requestId);
                        }}
                      >
                        Inspect request
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages.isError && (
        <div className="stack">
          <RequestFailure error={pages.error} />
          <Button
            size="sm"
            loading={pages.isFetching}
            onClick={() =>
              void queryClient.resetQueries({
                queryKey: timelinePagesQuery(conversationId).queryKey,
                exact: true,
              })
            }
          >
            Reload timeline
          </Button>
        </div>
      )}
      {pages.hasNextPage && !timelineChanged && (
        <div className="thread-foot">
          <Button
            size="sm"
            loading={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            {pages.isFetchNextPageError ? "Retry loading events" : "Load more events"}
          </Button>
        </div>
      )}
    </div>
  );
};

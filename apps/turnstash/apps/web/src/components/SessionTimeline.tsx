import type { TimelineEvent } from "@aqt/turnstash-api";
import { Badge } from "@aqt/ui/components/badge";
import { Button } from "@aqt/ui/components/button";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@aqt/ui/components/chart";
import { Spinner } from "@aqt/ui/components/spinner";
import { TableBody, TableHeader, TableRow } from "@aqt/ui/components/table";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Match } from "effect";
import { useMemo, useState } from "react";
import { Bar, Brush, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";

import { isTimelineChanged } from "../api";
import { dateTime, int, preciseUsd } from "../format";
import { timelinePagesQuery } from "../queries";
import { Pending, RequestFailure } from "./Async";
import { chartRow } from "./ChartRow";
import { DataTable, Td, Th } from "./DataTable";

const chartConfig = {
  cumulative: { label: "Cumulative priced cost", color: "var(--flame)" },
  cost: { label: "Request cost", color: "var(--chart-1)" },
} satisfies ChartConfig;

const eventLabel = (event: TimelineEvent) =>
  event.kind === "request" ? `Request · ${event.modelId}` : `Tool · ${event.toolName}`;

const eventColor = (event: TimelineEvent) => {
  if (event.kind === "request") return event.costUsd === null ? "var(--chart-4)" : "var(--flame)";
  if (event.toolStatus === "error") return "var(--destructive)";
  return event.toolStatus === "ok" ? "var(--chart-5)" : "var(--muted-foreground)";
};

const toolStatusLabel = (event: TimelineEvent) =>
  Match.value(event.toolStatus).pipe(
    Match.when("error", () => "Failed"),
    Match.when("ok", () => "OK"),
    Match.orElse(() => "Status unknown"),
  );

interface Point {
  readonly order: number;
  readonly label: string;
  readonly color: string;
  readonly messageKey: string | null;
  readonly cumulative: number;
  readonly cost: number | null;
}

// Recharts types the row behind each dot and bar as `any`; it is always one of the chart's points.
interface DotProps {
  readonly cx?: number | undefined;
  readonly cy?: number | undefined;
  readonly payload?: Point;
}

const pointDot = ({ cx, cy, payload }: DotProps) => (
  <circle
    cx={cx}
    cy={cy}
    r={3.5}
    fill="var(--background)"
    stroke={payload?.color}
    strokeWidth={2}
  />
);

// The hovered point's dot sits on top of the plain one, so it is the one that takes the click.
// Recharts rebinds DOM event props (onClick, onSelect, ...) on this element to its own payload.
const ActiveDot = ({
  cx,
  cy,
  payload,
  onPick,
}: DotProps & { readonly onPick: (point: Point) => void }) =>
  payload === undefined ? null : (
    <circle
      cx={cx}
      cy={cy}
      r={5}
      fill={payload.color}
      stroke="var(--background)"
      strokeWidth={2}
      className="cursor-pointer"
      onClick={() => onPick(payload)}
    />
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

  const [unlinkedEvent, setUnlinkedEvent] = useState<string | null>(null);
  const events = useMemo(
    () => (pages.data?.pages ?? []).flatMap((page) => page.items),
    [pages.data],
  );
  const points = useMemo(
    () =>
      events.map((event, index): Point => ({
        order: index + 1,
        label: eventLabel(event),
        color: eventColor(event),
        messageKey: event.messageKey,
        cumulative: event.cumulativeCostUsd,
        cost: event.kind === "request" ? event.costUsd : null,
      })),
    [events],
  );
  const pick = (point: Point) => {
    if (point.messageKey === null) setUnlinkedEvent(point.label);
    else
      void navigate({
        to: "/conversations/$id",
        params: { id: conversationId },
        search: { message: point.messageKey },
      });
  };

  if (pages.isPending) return <Pending />;
  if (pages.data === undefined)
    return (
      <div className="flex flex-col items-start gap-6">
        <RequestFailure error={pages.error ?? new Error("Could not load the timeline.")} />
        <Button size="sm" variant="outline" onClick={() => void pages.refetch()}>
          Retry timeline
        </Button>
      </div>
    );
  const timelineChanged = pages.error !== null && isTimelineChanged(pages.error);
  const summary = pages.data.pages.at(-1);
  if (summary === undefined || summary.totalEvents === 0)
    return (
      <p className="text-xs text-muted-foreground">
        No model requests or tool executions recorded.
      </p>
    );

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-muted-foreground">
        {preciseUsd(summary.pricedCostUsd)} priced request cost · {int(summary.unpricedRequests)}{" "}
        unpriced requests · {int(events.length)} of {int(summary.totalEvents)} events loaded. Tool
        events add no cost. Unknown times appear last. The chart uses event order, not elapsed time.
      </p>
      <ChartContainer
        config={chartConfig}
        className="aspect-auto h-80 w-full"
        role="img"
        aria-label="Cumulative priced request cost and individual request costs in event order. Use the event table below for transcript links and request inspection."
      >
        <ComposedChart data={points} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="order"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={16}
            height={44}
            label={{ value: "Event order", position: "insideBottom", offset: 4 }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={72}
            domain={[0, "auto"]}
            tickFormatter={preciseUsd}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload: ReadonlyArray<{ readonly payload?: Point }>) =>
                  payload[0]?.payload?.label
                }
                formatter={chartRow(preciseUsd)}
              />
            }
          />
          <ChartLegend verticalAlign="top" content={<ChartLegendContent />} />
          <Bar
            dataKey="cost"
            name={chartConfig.cost.label}
            fill="var(--color-cost)"
            radius={[3, 3, 0, 0]}
            maxBarSize={32}
            isAnimationActive={false}
            className="cursor-pointer"
            onClick={({ payload }: { readonly payload?: Point }) => {
              if (payload !== undefined) pick(payload);
            }}
          />
          <Line
            dataKey="cumulative"
            name={chartConfig.cumulative.label}
            type="stepAfter"
            stroke="var(--color-cumulative)"
            strokeWidth={2}
            isAnimationActive={false}
            dot={pointDot}
            activeDot={<ActiveDot onPick={pick} />}
          />
          <Brush
            dataKey="order"
            height={28}
            travellerWidth={8}
            stroke="var(--border)"
            fill="transparent"
          >
            <ComposedChart>
              <Line
                dataKey="cumulative"
                type="stepAfter"
                stroke="var(--color-cumulative)"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </Brush>
        </ComposedChart>
      </ChartContainer>
      {unlinkedEvent !== null && (
        <p role="status" className="text-xs text-muted-foreground">
          {unlinkedEvent}: no associated transcript message is recorded.
        </p>
      )}
      <div className="max-h-120 overflow-auto">
        <DataTable>
          <caption className="sr-only">
            Session events in chronological order. Equal timestamps use event type and source key.
            Events without times appear last.
          </caption>
          <TableHeader>
            <TableRow>
              <Th scope="col" className="sm:top-0">
                Time
              </Th>
              <Th scope="col" className="sm:top-0">
                Event
              </Th>
              <Th scope="col" numeric className="sm:top-0">
                Request cost
              </Th>
              <Th scope="col" numeric className="sm:top-0">
                Cumulative priced
              </Th>
              <Th scope="col" className="sm:top-0">
                Source
              </Th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => (
              <TableRow key={event.eventKey}>
                <Td title={event.timestamp ?? "No timestamp recorded"}>
                  {event.timestamp === null ? "Unknown time" : dateTime(event.timestamp)}
                </Td>
                <Td>
                  <span>{eventLabel(event)}</span>
                  {event.previousModelId !== null && (
                    <div className="text-xs text-muted-foreground">
                      Model changed from {event.previousModelId}
                    </div>
                  )}
                  {event.kind === "tool" && (
                    <div>
                      <Badge variant={event.toolStatus === "error" ? "destructive" : "secondary"}>
                        {toolStatusLabel(event)}
                      </Badge>
                    </div>
                  )}
                </Td>
                <Td numeric title={event.unpricedReason ?? undefined}>
                  {event.kind === "tool"
                    ? "No separate cost"
                    : event.costUsd === null
                      ? "Unpriced"
                      : preciseUsd(event.costUsd)}
                </Td>
                <Td numeric>
                  {preciseUsd(event.cumulativeCostUsd)}
                  {event.cumulativeUnpricedRequests > 0 && (
                    <div className="text-xs text-muted-foreground">
                      + {int(event.cumulativeUnpricedRequests)} unpriced
                    </div>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap items-center gap-2">
                    {event.messageKey === null ? (
                      <span className="text-xs text-muted-foreground">
                        No transcript association
                      </span>
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
                </Td>
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      </div>
      {pages.isError && (
        <div className="flex flex-col items-start gap-6">
          <RequestFailure error={pages.error} />
          <Button
            size="sm"
            variant="outline"
            disabled={pages.isFetching}
            onClick={() =>
              void queryClient.resetQueries({
                queryKey: timelinePagesQuery(conversationId).queryKey,
                exact: true,
              })
            }
          >
            {pages.isFetching && <Spinner data-icon="inline-start" />}
            Reload timeline
          </Button>
        </div>
      )}
      {pages.hasNextPage && !timelineChanged && (
        <div className="pt-3">
          <Button
            size="sm"
            variant="outline"
            disabled={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            {pages.isFetchingNextPage && <Spinner data-icon="inline-start" />}
            {pages.isFetchNextPageError ? "Retry loading events" : "Load more events"}
          </Button>
        </div>
      )}
    </div>
  );
};

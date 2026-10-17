import type { TurnView } from "@aqt/turnstash-api";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@aqt/ui/components/chart";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { compact, usd } from "../format";
import { chartRow } from "./ChartRow";

const chartConfig = { costUsd: { label: "Cost", color: "var(--primary)" } } satisfies ChartConfig;

const axisWidth = 44;

// Recharts types the row behind each tooltip entry as `any`; it is always one of the turns.
interface TurnEntry {
  readonly payload?: TurnView;
}

const TurnLabel = ({ turn }: { readonly turn: TurnView }) => (
  <div className="flex max-w-72 flex-col gap-0.5">
    <span>
      Turn {turn.turnIndex + 1} · {turn.category}
    </span>
    {turn.userExcerpt !== "" && (
      <span className="line-clamp-2 font-normal text-muted-foreground">{turn.userExcerpt}</span>
    )}
  </div>
);

const turnLabel = (_label: ReactNode, payload: ReadonlyArray<TurnEntry>) => {
  const turn = payload[0]?.payload;
  return turn === undefined ? null : <TurnLabel turn={turn} />;
};

// Each turn's column is a link laid over the chart, so a turn opens by keyboard, from a screen
// reader or in a new tab, and a $0 turn without a visible bar still has a target. The links take
// the pointer from the chart, so they drive its tooltip.
export const TurnStrip = ({
  turns,
  conversationId,
}: {
  readonly turns: ReadonlyArray<TurnView>;
  readonly conversationId: string;
}) => {
  const [active, setActive] = useState<number | null>(null);
  return (
    <div className="relative">
      <ChartContainer config={chartConfig} className="aspect-auto h-36 w-full" aria-hidden>
        <BarChart
          data={[...turns]}
          margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
          accessibilityLayer={false}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey={(turn: TurnView) => turn.turnIndex + 1}
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={16}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={axisWidth}
            tickFormatter={(value: number) => `$${compact(value)}`}
          />
          <ChartTooltip
            defaultIndex={active}
            cursor={{ fill: "var(--muted)" }}
            content={<ChartTooltipContent labelFormatter={turnLabel} formatter={chartRow(usd)} />}
          />
          <Bar
            dataKey="costUsd"
            name={chartConfig.costUsd.label}
            fill="var(--color-costUsd)"
            radius={[2, 2, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ChartContainer>
      <ol
        aria-label="Turns"
        className="absolute inset-y-0 right-0 flex"
        style={{ left: axisWidth }}
        onPointerLeave={() => setActive(null)}
      >
        {turns.map((turn, index) => {
          const label = `Turn ${turn.turnIndex + 1}, ${turn.category}, ${usd(turn.costUsd)}`;
          return (
            <li
              key={turn.turnIndex}
              className="min-w-0 flex-1"
              onPointerEnter={() => setActive(index)}
            >
              {turn.messageKey === null ? (
                <span className="sr-only">{label}</span>
              ) : (
                <Link
                  to="/conversations/$id"
                  params={{ id: conversationId }}
                  search={{ message: turn.messageKey }}
                  aria-label={label}
                  className="block size-full rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  onFocus={() => setActive(index)}
                  onBlur={() => setActive(null)}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
};

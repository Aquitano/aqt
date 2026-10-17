import type { TurnView } from "@aqt/turnstash-api";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@aqt/ui/components/chart";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { compact, usd } from "../format";
import { chartRow } from "./ChartRow";

const chartConfig = { costUsd: { label: "Cost", color: "var(--primary)" } } satisfies ChartConfig;

// Recharts types the row behind each bar and tooltip entry as `any`; it is always one of the turns.
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

export const TurnStrip = ({
  turns,
  conversationId,
}: {
  readonly turns: ReadonlyArray<TurnView>;
  readonly conversationId: string;
}) => {
  const navigate = useNavigate();
  const open = (turn: TurnView | undefined) => {
    if (turn?.messageKey === null || turn === undefined) return;
    void navigate({
      to: "/conversations/$id",
      params: { id: conversationId },
      search: { message: turn.messageKey },
    });
  };
  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto h-36 w-full"
      role="img"
      aria-label="Cost of each turn in order. Select a bar to open that turn in the transcript."
    >
      <BarChart data={[...turns]} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
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
          width={44}
          tickFormatter={(value: number) => `$${compact(value)}`}
        />
        <ChartTooltip
          cursor={{ fill: "var(--muted)" }}
          content={<ChartTooltipContent labelFormatter={turnLabel} formatter={chartRow(usd)} />}
        />
        <Bar
          dataKey="costUsd"
          name={chartConfig.costUsd.label}
          fill="var(--color-costUsd)"
          radius={[2, 2, 0, 0]}
          isAnimationActive={false}
          className="cursor-pointer"
          onClick={({ payload }: TurnEntry) => open(payload)}
        />
      </BarChart>
    </ChartContainer>
  );
};

import type { DayRow, Overall, PlanCost, Stats, SubscriptionValue } from "@aqt/turnstash-api";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowDownRightIcon, ArrowUpRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { compact, int, moneyList, pct, usd } from "../format";
import { ymd } from "../period";
import { useTokenTotal } from "../token-total";

// Change against the window of the same length before this one. Spending more reads as up in red.
const Delta = ({ now, previous }: { readonly now: number; readonly previous: number | null }) => {
  if (previous === null || previous <= 0) return null;
  const change = (now - previous) / previous;
  if (!Number.isFinite(change) || Math.abs(change) < 0.005) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[13px] font-medium tracking-normal",
        change > 0 ? "text-destructive" : "text-success",
      )}
    >
      {change > 0 ? (
        <ArrowUpRightIcon className="size-3.5" />
      ) : (
        <ArrowDownRightIcon className="size-3.5" />
      )}
      {pct(Math.abs(change))}
    </span>
  );
};

interface MonthToDate {
  readonly spent: number;
  readonly projected: number;
  readonly dayOfMonth: number;
  readonly daysInMonth: number;
}

// Only meaningful when the window covers the month so far; a "today" view starts mid-month.
const monthToDate = (daily: ReadonlyArray<DayRow>, range: Stats["range"]): MonthToDate | null => {
  const now = new Date();
  const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  if (range !== null && ymd(new Date(range.from)) > firstOfMonth) return null;
  const spent = daily
    .filter((day) => day.date >= firstOfMonth)
    .reduce((sum, day) => sum + day.costUsd, 0);
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return { spent, projected: (spent / dayOfMonth) * daysInMonth, dayOfMonth, daysInMonth };
};

const totalsByCurrency = (rows: ReadonlyArray<SubscriptionValue>): ReadonlyArray<PlanCost> => {
  const totals = new Map<string, number>();
  for (const { currency, amount } of rows.flatMap((row) => row.planCosts))
    totals.set(currency, (totals.get(currency) ?? 0) + amount);
  return [...totals].map(([currency, amount]) => ({ currency, amount }));
};

const Figure = ({
  label,
  value,
  sub,
  lead = false,
}: {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly sub?: ReactNode;
  readonly lead?: boolean;
}) => (
  <div className={cn("flex min-w-0 flex-col gap-0.5", lead && "max-sm:col-span-full")}>
    <span
      className={cn(
        "flex flex-wrap items-baseline gap-2.5 leading-tight font-medium tracking-tight",
        lead ? "text-[40px] tracking-[-0.03em] max-sm:text-[32px]" : "text-[22px]",
      )}
    >
      {value}
    </span>
    <span className="text-[13px]">{label}</span>
    {sub !== undefined && (
      <span className="text-xs text-muted-foreground [&_a]:text-flame [&_a]:hover:underline">
        {sub}
      </span>
    )}
  </div>
);

export const StatTiles = ({
  overall,
  previous,
  daily,
  range,
  subscriptions,
}: {
  readonly overall: Overall;
  readonly previous: Overall | null;
  readonly daily: ReadonlyArray<DayRow>;
  readonly range: Stats["range"];
  readonly subscriptions: ReadonlyArray<SubscriptionValue>;
}) => {
  const month = monthToDate(daily, range);
  const cacheDenominator = overall.cacheReadTokens + overall.inputTokens;
  const cacheHitRate = cacheDenominator > 0 ? overall.cacheReadTokens / cacheDenominator : 0;
  const perConversation = overall.conversations > 0 ? overall.costUsd / overall.conversations : 0;
  const [tokenTotal] = useTokenTotal();
  const withCache = tokenTotal === "withCache";
  const cacheTokens = overall.cacheReadTokens + overall.cacheWriteTokens;
  const tokens = overall.inputTokens + overall.outputTokens + (withCache ? cacheTokens : 0);
  const tokenBreakdown = (format: (value: number) => string) =>
    [
      `${format(overall.inputTokens)} in`,
      `${format(overall.outputTokens)} out`,
      ...(withCache ? [`${format(cacheTokens)} cache`] : []),
    ].join(", ");

  return (
    <div className="grid grid-cols-2 gap-x-8 gap-y-4 border-y py-5 sm:grid-cols-[minmax(220px,1.4fr)_repeat(auto-fit,minmax(150px,1fr))]">
      <Figure
        lead
        label="API-equivalent cost"
        value={
          <>
            {usd(overall.costUsd)}
            <Delta now={overall.costUsd} previous={previous === null ? null : previous.costUsd} />
          </>
        }
        sub={
          overall.unpricedRequests > 0 ? (
            <>
              {usd(perConversation)} per conversation,{" "}
              <Link to="/settings">{int(overall.unpricedRequests)} requests unpriced</Link>
            </>
          ) : (
            `${usd(perConversation)} per conversation`
          )
        }
      />
      {subscriptions.length > 0 && (
        <Figure
          label="Subscriptions"
          value={moneyList(totalsByCurrency(subscriptions))}
          sub="plan cost over this window"
        />
      )}
      <Figure
        label="Conversations"
        value={
          <>
            {int(overall.conversations)}
            <Delta
              now={overall.conversations}
              previous={previous === null ? null : previous.conversations}
            />
          </>
        }
        sub={`${int(overall.requests)} requests, ${int(overall.messages)} messages`}
      />
      <Figure
        label="Tokens"
        value={<span title={tokenBreakdown(int)}>{compact(tokens)}</span>}
        sub={tokenBreakdown(compact)}
      />
      <Figure
        label="Cache hit rate"
        value={pct(cacheHitRate)}
        sub={`${compact(overall.cacheReadTokens)} read, ${compact(overall.cacheWriteTokens)} written`}
      />
      {month !== null && (
        <Figure
          label="Month to date"
          value={usd(month.spent)}
          sub={`on track for ${usd(month.projected)}, day ${month.dayOfMonth} of ${month.daysInMonth}`}
        />
      )}
    </div>
  );
};

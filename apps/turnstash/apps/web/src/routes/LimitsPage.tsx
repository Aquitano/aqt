import {
  type LimitSeries,
  type LimitWindow,
  providerLabels,
  providerIds,
  type ProviderId,
  type ProviderLimits,
} from "@aqt/turnstash-api";
import { Button, buttonVariants } from "@aqt/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@aqt/ui/components/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aqt/ui/components/select";
import { TableBody, TableHeader, TableRow } from "@aqt/ui/components/table";
import { ToggleGroup, ToggleGroupItem } from "@aqt/ui/components/toggle-group";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronLeftIcon, ChevronRightIcon, GaugeIcon, XIcon } from "lucide-react";
import { type ReactNode } from "react";

import { isUnauthorized } from "../api";
import { Async } from "../components/Async";
import { DataTable, Td, Th } from "../components/DataTable";
import { DrainRange } from "../components/DrainRange";
import { DrainChart, type LimitSelection, RemainingChart } from "../components/LimitChart";
import { Page, PageHead } from "../components/Page";
import { ProviderIcon } from "../components/ProviderIcon";
import { Section, surface } from "../components/Section";
import { quietControl, Segmented } from "../components/Segmented";
import { useCollapse } from "../components/Tables";
import { UseFirstLine } from "../components/UseFirstLine";
import { useFilters } from "../filters";
import { dayTime, int, moneyList, relativeTime, usd, weekdayTime } from "../format";
import {
  burnPerHour,
  type BurnMode,
  chartRowsOf,
  dayMs,
  drainBucketsOf,
  drainBurstsOf,
  drainSelectionOf,
  futureFactors,
  type FutureUsage,
  type LimitSpan,
  hourMs,
  latestCostPerPercent,
  openWindowOf,
  primarySeriesOf,
  paceOf,
  projectLimit,
  spanFor,
  windowLabel,
} from "../limits-model";
import { limitDrainQuery, limitsQuery } from "../queries";
import type { LimitsSearch } from "../search-state";

type LimitView = "remaining" | "drain";

const viewOptions = [
  { value: "remaining", label: "Remaining" },
  { value: "drain", label: "Drain rate" },
] as const;

const burnOptions = [
  { value: "window", label: "This window" },
  { value: "6h", label: "6h" },
  { value: "3h", label: "3h" },
  { value: "1h", label: "1h" },
] as const;

const futureOptions = [
  { value: "same", label: "Same as now" },
  { value: "half", label: "Half as much" },
  { value: "double", label: "Twice as much" },
  { value: "none", label: "Stop now" },
] as const;

const providerColor = (provider: ProviderId): string => `var(--provider-${provider})`;

const percent = (value: number) => `${Math.round(value)}%`;

const dayLabel = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const Kpi = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <div className="min-w-0">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="mt-0.5 font-medium whitespace-nowrap">{children}</dd>
  </div>
);

const paceText = { ahead: "ahead of pace", on: "on pace", under: "under pace" } as const;

const DrainDetails = ({
  provider,
  selection,
  onClear,
}: {
  readonly provider: ProviderId;
  readonly selection: LimitSelection;
  readonly onClear: () => void;
}) => {
  const drain = useQuery(
    limitDrainQuery({
      provider,
      from: new Date(selection.fromMs).toISOString(),
      to: new Date(selection.toMs).toISOString(),
    }),
  );
  return (
    <div className="mt-3 rounded-xl bg-muted/40 p-3 sm:p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="font-medium" aria-live="polite" aria-atomic="true">
          {dayTime(selection.fromMs)} to {dayTime(selection.toMs)}
          {drain.data !== undefined && !(drain.isError && isUnauthorized(drain.error)) && (
            <span className="ml-2 font-normal text-muted-foreground">
              {usd(drain.data.costUsd)} at API rates, {int(drain.data.requests)}{" "}
              {drain.data.requests === 1 ? "request" : "requests"}
            </span>
          )}
        </p>
        <Button size="icon-xs" variant="ghost" aria-label="Clear selection" onClick={onClear}>
          <XIcon />
        </Button>
      </div>
      <Async query={drain}>
        {(data) =>
          data.requests === 0 ? (
            <p className="text-muted-foreground">
              No recorded requests in this interval. Usage readings may include requests that have
              not been collected.
            </p>
          ) : (
            <div className="grid gap-x-8 gap-y-3 lg:grid-cols-[3fr_2fr]">
              <ul className="flex min-w-0 flex-col gap-1">
                {data.conversations.map((row) => (
                  <li key={row.id} className="flex items-baseline justify-between gap-3">
                    <Link
                      to="/conversations/$id"
                      params={{ id: row.id }}
                      className="min-w-0 truncate underline-offset-2 outline-none hover:underline focus-visible:underline"
                    >
                      {row.title ?? row.projectKey ?? "Untitled conversation"}
                    </Link>
                    <span className="shrink-0 text-muted-foreground">{usd(row.costUsd)}</span>
                  </li>
                ))}
              </ul>
              <ul className="flex min-w-0 flex-col gap-1">
                {data.projects.slice(0, 8).map((row) => (
                  <li
                    key={row.projectKey}
                    className="flex items-baseline justify-between gap-3"
                    title={row.projectPath ?? undefined}
                  >
                    <Link
                      to="/projects/$key"
                      params={{ key: row.projectKey }}
                      className="min-w-0 truncate underline-offset-2 outline-none hover:underline focus-visible:underline"
                    >
                      {row.projectKey}
                    </Link>
                    <span className="shrink-0 text-muted-foreground">{usd(row.costUsd)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )
        }
      </Async>
    </div>
  );
};

const LimitCard = ({
  limits,
  nowMs,
  weekOffset,
  anchorMs,
  pendingHistory,
  view,
  burnMode,
  future,
}: {
  readonly limits: ProviderLimits;
  readonly nowMs: number;
  readonly weekOffset: number;
  readonly anchorMs: number;
  readonly pendingHistory: boolean;
  readonly view: LimitView;
  readonly burnMode: BurnMode;
  readonly future: FutureUsage;
}) => {
  const state = useSearch({ from: "/limits" });
  const navigate = useNavigate({ from: "/limits" });
  const minutes = state.windows?.[limits.provider];
  const setMinutes = (window: number) =>
    void navigate({
      to: "/limits",
      search: {
        ...state,
        windows: { ...state.windows, [limits.provider]: window },
        ...(state.selectionProvider === limits.provider
          ? { selectionProvider: undefined, from: undefined, to: undefined }
          : {}),
      },
      resetScroll: false,
    });
  const series: LimitSeries | undefined =
    limits.series.find((candidate) => candidate.windowMinutes === minutes) ??
    primarySeriesOf(limits.series);
  const color = providerColor(limits.provider);
  const name = providerLabels[limits.provider];

  if (series === undefined)
    return (
      <Section
        title={
          <span className="flex items-center gap-2">
            <ProviderIcon provider={limits.provider} />
            {name}
          </span>
        }
        note={`${limits.hits.length} limit ${limits.hits.length === 1 ? "hit" : "hits"}`}
      >
        <p className="text-muted-foreground">
          Hits are recorded, but no usage reading yet. Run turnstash sync on a machine signed in to{" "}
          {name}.
        </p>
      </Section>
    );

  const open = openWindowOf(series);
  const remaining = open === null ? 100 : 100 - open.usedPercent;
  const span = spanFor(series.windowMinutes, weekOffset, anchorMs);
  const selection = drainSelectionOf(
    state.selectionProvider === limits.provider &&
      state.from !== undefined &&
      state.to !== undefined
      ? { fromMs: state.from, toMs: state.to }
      : null,
    span,
    nowMs,
  );
  const setSelection = (range: LimitSelection | null) => {
    const selected = drainSelectionOf(range, span, nowMs);
    void navigate({
      to: "/limits",
      search: {
        ...state,
        selectionProvider: selected === null ? undefined : limits.provider,
        from: selected?.fromMs,
        to: selected?.toMs,
      },
      resetScroll: false,
    });
  };
  const baseBurn = burnPerHour(open, burnMode, nowMs);
  const burn = baseBurn * futureFactors[future];
  const projection = projectLimit({
    open,
    windowMinutes: series.windowMinutes,
    nowMs,
    burn,
    untilMs: span.toMs,
  });
  const short = series.windowMinutes < 24 * 60;
  const { rows, jumps } = chartRowsOf({
    windows: series.windows,
    projection,
    span,
    nowMs,
    stepMs: short ? 15 * 60_000 : hourMs,
  });
  const bucketMs = (short ? 3 : 6) * hourMs;
  const buckets = drainBucketsOf(series.windows, span, bucketMs, nowMs);
  const bursts = drainBurstsOf(series.windows).filter(
    (burst) => burst.toMs > span.fromMs && burst.fromMs < Math.min(span.toMs, nowMs),
  );
  const pace = paceOf(open, nowMs);
  const costPerPercent = latestCostPerPercent(series);
  const hits = limits.hits.filter(
    (hit) =>
      (hit.windowMinutes === null || hit.windowMinutes === series.windowMinutes) &&
      Date.parse(hit.at) >= span.fromMs &&
      Date.parse(hit.at) < span.toMs,
  );
  const atReset = projection.remainingAtReset;
  const label = `${name} ${windowLabel(series.windowMinutes).toLowerCase()} limit, ${percent(remaining)} left`;

  return (
    <section className={cn(surface, "p-4 sm:p-6")}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="flex min-w-0 items-center gap-2 text-[15px] font-medium tracking-tight">
          <ProviderIcon provider={limits.provider} />
          {name}
          {limits.plan !== null && (
            <span className="font-normal text-muted-foreground">{limits.plan}</span>
          )}
        </h2>
        {limits.series.length > 1 && (
          <Segmented
            label={`${name} limit window`}
            options={limits.series.map((candidate) => ({
              value: String(candidate.windowMinutes),
              label: windowLabel(candidate.windowMinutes),
            }))}
            value={String(series.windowMinutes)}
            onChange={(value) => {
              setMinutes(Number(value));
            }}
          />
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-end justify-between gap-x-10 gap-y-3">
        <div className="min-w-0">
          <p className="flex items-baseline gap-2">
            <span className="text-[44px] leading-none font-semibold tracking-tight">
              {percent(remaining)}
            </span>
            <span className="text-muted-foreground">of 100% left</span>
          </p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {open === null
              ? "The next window starts with your next request"
              : `${percent(open.usedPercent)} used with ${percent((pace?.elapsedShare ?? 0) * 100)} of the window gone, ${paceText[pace?.pace ?? "on"]}. Latest reading ${relativeTime(open.lastObservedAt)}.`}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-7 gap-y-2.5 sm:flex sm:flex-wrap">
          <Kpi label="Runs out">
            {remaining <= 0
              ? "Out now"
              : projection.emptyAtMs === null
                ? open === null
                  ? "No window open"
                  : "Not before reset"
                : weekdayTime(projection.emptyAtMs)}
          </Kpi>
          <Kpi label="Projected unused">
            {atReset === null ? "Nothing" : percent(atReset)}
            {atReset !== null && atReset > 0 && costPerPercent !== null && (
              <span className="block text-xs font-normal text-muted-foreground">
                {usd(atReset * costPerPercent)} at API rates
              </span>
            )}
          </Kpi>
          <Kpi label="Next reset">
            {open === null ? (
              "On first use"
            ) : (
              <>
                {`+${Math.round(100 - (atReset ?? remaining))}%`}{" "}
                <span className="font-normal">{weekdayTime(Date.parse(open.resetsAt))}</span>
              </>
            )}
          </Kpi>
          <Kpi
            label={burnMode === "window" ? "Burn, this window" : `Burn, last ${burnMode}`}
          >{`${baseBurn.toFixed(1)}%/h`}</Kpi>
          {costPerPercent !== null && <Kpi label="API cost per 1%">{usd(costPerPercent)}</Kpi>}
        </dl>
      </div>

      <div className="mt-4">
        <p className="mb-2 text-xs text-muted-foreground">
          {dayLabel(span.fromMs)} to {dayLabel(span.toMs)}
        </p>
        {!pendingHistory &&
          !series.windows.some((window) =>
            window.points.some(
              (point) => Date.parse(point.at) >= span.fromMs && Date.parse(point.at) < span.toMs,
            ),
          ) && (
            <p role="status" className="mb-2 text-sm text-muted-foreground">
              No readings in this range.{" "}
              {weekOffset === 0
                ? "Sync an agent to record usage."
                : "Choose a later week to find recorded usage."}
            </p>
          )}
        {view === "remaining" ? (
          <RemainingChart
            rows={rows}
            span={span}
            nowMs={nowMs}
            color={color}
            projection={projection}
            jumps={jumps}
            hits={hits}
            bursts={bursts}
            selection={selection}
            onSelect={setSelection}
            label={label}
          />
        ) : (
          <DrainChart
            buckets={buckets}
            bucketMs={bucketMs}
            span={span}
            nowMs={nowMs}
            color={color}
            selection={selection}
            onSelect={setSelection}
            label={`${name} hourly drain rate, grouped in ${short ? "three" : "six"}-hour intervals`}
          />
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full" style={{ background: color }} />
            {view === "remaining" ? "Recorded" : `Hourly rate, ${short ? 3 : 6}-hour intervals`}
          </span>
          {view === "remaining" && projection.points.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-0.5 w-4"
                style={{
                  background: `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)`,
                }}
              />
              Projected
            </span>
          )}
          {view === "remaining" && hits.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-destructive" />
              Limit hit
            </span>
          )}
        </div>
        <span>
          {view === "remaining"
            ? "Drag across the chart or choose a time range below"
            : "Select a bar or choose a time range below"}
        </span>
      </div>

      {view === "drain" && (
        <p className="mt-2 text-xs text-muted-foreground">
          Bars group reported increases. Request details cover the full interval between readings.
          Live rates use a minimum one-hour average.
        </p>
      )}

      {bursts.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">Largest drains</span>
          {bursts.slice(0, 5).map((burst) => (
            <Button
              key={burst.fromMs}
              size="xs"
              variant={selection?.fromMs === burst.fromMs ? "secondary" : "ghost"}
              className={cn("font-normal", selection?.fromMs !== burst.fromMs && quietControl)}
              onClick={() => setSelection(burst)}
            >
              {`−${Math.round(burst.drop)}%`}
              <span className="text-muted-foreground">{dayTime(burst.fromMs)}</span>
            </Button>
          ))}
        </div>
      )}

      <DrainRange
        key={`${series.windowMinutes}:${span.fromMs}`}
        span={span}
        nowMs={nowMs}
        selection={selection}
        onSelect={setSelection}
      />

      {selection !== null && (selection.fromMs < span.fromMs || selection.toMs > span.toMs) && (
        <p className="mt-3 text-xs text-muted-foreground">
          This observation interval extends beyond the chart. Request details include the full
          interval.
        </p>
      )}

      {selection !== null && (
        <DrainDetails
          provider={limits.provider}
          selection={selection}
          onClear={() => setSelection(null)}
        />
      )}
    </section>
  );
};

const endedText = (window: LimitWindow): string => {
  if (window.outcome !== "replaced") return "Ran to its reset";
  const days = (Date.parse(window.resetsAt) - Date.parse(window.endedAt)) / dayMs;
  if (days >= 1) {
    const count = Number(days.toFixed(1));
    return `Replaced ${count} ${count === 1 ? "day" : "days"} early`;
  }
  const minutes = Math.round(days * 24 * 60);
  if (minutes < 60) return `Replaced ${minutes} ${minutes === 1 ? "minute" : "minutes"} early`;
  const hours = Number((minutes / 60).toFixed(1));
  return `Replaced ${hours} ${hours === 1 ? "hour" : "hours"} early`;
};

const WindowLedger = ({
  providers,
  span,
}: {
  readonly providers: ReadonlyArray<ProviderLimits>;
  readonly span: LimitSpan;
}) => {
  const rows = providers
    .flatMap((limits) =>
      limits.series
        .flatMap((series) => series.windows)
        .filter(
          (window) =>
            window.outcome !== "open" &&
            Date.parse(window.endedAt) >= span.fromMs &&
            Date.parse(window.endedAt) < span.toMs,
        )
        .map((window) => ({ provider: limits.provider, window })),
    )
    .toSorted((a, b) => Date.parse(b.window.endedAt) - Date.parse(a.window.endedAt));
  const collapse = useCollapse(rows);
  if (rows.length === 0) return null;
  const expired = new Map<string, number>();
  for (const { window } of rows)
    for (const { currency, amount } of window.expiredValue)
      expired.set(currency, (expired.get(currency) ?? 0) + amount);
  const expiredTotal = [...expired].map(([currency, amount]) => ({ currency, amount }));
  return (
    <Section
      title="How each window ended"
      note={
        expiredTotal.length > 0
          ? `${moneyList(expiredTotal)} of plan cost expired unused across all rows, counted once on the longest active window`
          : "quota left when each window closed"
      }
    >
      <DataTable>
        <TableHeader>
          <TableRow>
            <Th>Window</Th>
            <Th numeric>Used</Th>
            <Th numeric>Left</Th>
            <Th numeric>API value</Th>
            <Th numeric>API cost per 1%</Th>
            <Th numeric>Plan cost expired</Th>
            <Th numeric>Ended</Th>
          </TableRow>
        </TableHeader>
        <TableBody>
          {collapse.shown.map(({ provider, window }) => (
            <TableRow key={`${provider}:${window.windowMinutes}:${window.resetsAt}`}>
              <Td className="whitespace-nowrap">
                <span className="inline-flex items-center gap-2">
                  <ProviderIcon provider={provider} className="size-3.5" />
                  <span className="sr-only">{providerLabels[provider]} </span>
                  <span>
                    {windowLabel(window.windowMinutes)}
                    <span className="block text-xs text-muted-foreground">
                      {dayTime(Date.parse(window.startsAt))} to{" "}
                      {dayTime(Date.parse(window.endedAt))}
                    </span>
                  </span>
                </span>
              </Td>
              <Td numeric>{percent(window.usedPercent)}</Td>
              <Td numeric>{percent(100 - window.usedPercent)}</Td>
              <Td numeric>{window.requests === 0 ? "" : usd(window.costUsd)}</Td>
              <Td numeric>
                {window.costPerPercentUsd === null ? "" : usd(window.costPerPercentUsd)}
              </Td>
              <Td numeric>
                {window.expiredValue.length > 0 ? moneyList(window.expiredValue) : ""}
              </Td>
              <Td numeric className="text-muted-foreground">
                {endedText(window)}
              </Td>
            </TableRow>
          ))}
        </TableBody>
      </DataTable>
      {collapse.toggle}
    </Section>
  );
};

const allProviders = "all";

const ProviderTabs = ({
  providers,
  value,
  onChange,
}: {
  readonly providers: ReadonlyArray<ProviderLimits>;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) => (
  <ToggleGroup
    aria-label="Provider"
    size="sm"
    spacing={0}
    className="flex-wrap gap-1"
    value={[value]}
    onValueChange={([next]) => {
      if (next !== undefined) onChange(next);
    }}
  >
    {[
      { key: allProviders, label: "All", icon: null },
      ...providers.map(({ provider }) => ({
        key: provider,
        label: providerLabels[provider],
        icon: <ProviderIcon provider={provider} className="size-3.5" />,
      })),
    ].map((tab) => (
      <ToggleGroupItem
        key={tab.key}
        value={tab.key}
        className="h-8 gap-2 rounded-lg! px-3! font-normal text-muted-foreground hover:bg-muted/70 aria-pressed:bg-muted aria-pressed:text-foreground"
      >
        {tab.icon}
        {tab.label}
        {tab.key === allProviders && (
          <span className="text-muted-foreground">{providers.length}</span>
        )}
      </ToggleGroupItem>
    ))}
  </ToggleGroup>
);

export const LimitsPage = () => {
  const state = useSearch({ from: "/limits" });
  const navigate = useNavigate({ from: "/limits" });
  const { today } = useFilters();
  const anchorMs = today.getTime();
  const weekOffset = state.week ?? 0;
  const tab = state.provider ?? allProviders;
  const view = state.view ?? "remaining";
  const burnMode = state.burn ?? "window";
  const future = state.future ?? "same";
  const update = (patch: Partial<LimitsSearch>) =>
    void navigate({
      to: "/limits",
      search: {
        ...state,
        ...("provider" in patch
          ? { selectionProvider: undefined, from: undefined, to: undefined }
          : {}),
        ...patch,
      },
      resetScroll: false,
    });
  const historySearch = (week: number | undefined): LimitsSearch => ({
    ...state,
    week,
    selectionProvider: undefined,
    from: undefined,
    to: undefined,
  });
  const page = spanFor(10_080, weekOffset, anchorMs);
  const report = useQuery({
    ...limitsQuery({
      from: new Date(page.fromMs).toISOString(),
      to: new Date(page.toMs).toISOString(),
    }),
    placeholderData: keepPreviousData,
  });
  const providerCount = report.data?.providers.length ?? 0;

  return (
    <Page>
      <PageHead
        title="Limits"
        note={
          providerCount > 0
            ? `${providerCount} ${providerCount === 1 ? "provider" : "providers"}, read from your agents`
            : undefined
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-xs text-muted-foreground">
          {report.isPlaceholderData
            ? "Updating limits…"
            : weekOffset < 0
              ? "Browsing history. Summary figures show current limits."
              : "Current limits and usage history"}
        </p>
        <div className="ml-auto flex items-center gap-1">
          <span className="mr-1.5 text-[13px] text-muted-foreground">
            {dayLabel(page.fromMs)} to {dayLabel(page.toMs)}
          </span>
          <Link
            to="/limits"
            search={historySearch(weekOffset - 1)}
            resetScroll={false}
            disabled={weekOffset <= -5200}
            aria-label="Previous week"
            className={cn(
              buttonVariants({ size: "icon-sm", variant: "ghost" }),
              "aria-disabled:pointer-events-none aria-disabled:opacity-50",
            )}
          >
            <ChevronLeftIcon />
          </Link>
          <Link
            to="/limits"
            search={historySearch(undefined)}
            resetScroll={false}
            disabled={weekOffset === 0}
            className={cn(
              buttonVariants({ size: "sm", variant: "ghost" }),
              quietControl,
              "aria-disabled:pointer-events-none aria-disabled:opacity-50",
            )}
          >
            Today
          </Link>
          <Link
            to="/limits"
            search={historySearch(weekOffset + 1)}
            resetScroll={false}
            disabled={weekOffset >= 0}
            aria-label="Next week"
            className={cn(
              buttonVariants({ size: "icon-sm", variant: "ghost" }),
              "aria-disabled:pointer-events-none aria-disabled:opacity-50",
            )}
          >
            <ChevronRightIcon />
          </Link>
        </div>
      </div>
      <Async query={report}>
        {(data) => {
          if (data.providers.length === 0)
            return (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <GaugeIcon />
                  </EmptyMedia>
                  <EmptyTitle>No plan limits recorded yet</EmptyTitle>
                  <EmptyDescription>
                    Codex reports its limits in every transcript. Claude Code's are read from its
                    local cache. A sync brings in both.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                    turnstash sync
                  </code>
                </EmptyContent>
              </Empty>
            );
          const nowMs = Date.parse(data.generatedAt);
          const shown = data.providers.filter(
            (limits) => tab === allProviders || limits.provider === tab,
          );
          return (
            <>
              <ProviderTabs
                providers={data.providers}
                value={tab}
                onChange={(value) =>
                  update({ provider: providerIds.find((provider) => provider === value) })
                }
              />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Segmented
                  label="Chart"
                  options={viewOptions}
                  value={view}
                  onChange={(view) => update({ view })}
                />
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-muted-foreground">Burn rate</span>
                  <Segmented
                    label="Burn rate"
                    options={burnOptions}
                    value={burnMode}
                    onChange={(burn) => update({ burn })}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-muted-foreground">Future usage</span>
                  <Select
                    items={futureOptions}
                    value={future}
                    onValueChange={(next) => {
                      if (next !== null) update({ future: next });
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Future usage" className={quietControl}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {futureOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <UseFirstLine
                providers={data.providers}
                className={cn(surface, "px-4 py-2.5 sm:px-6")}
              />
              {shown.length === 0 && (
                <p className="text-muted-foreground">
                  No readings for this provider. Choose All to see the available providers.
                </p>
              )}
              {shown.map((limits) => (
                <LimitCard
                  key={limits.provider}
                  limits={limits}
                  nowMs={nowMs}
                  weekOffset={weekOffset}
                  anchorMs={anchorMs}
                  pendingHistory={report.isPlaceholderData}
                  view={view}
                  burnMode={burnMode}
                  future={future}
                />
              ))}
              <WindowLedger providers={shown} span={page} />
            </>
          );
        }}
      </Async>
    </Page>
  );
};

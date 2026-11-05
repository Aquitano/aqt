import {
  type LimitSeries,
  type LimitWindow,
  providerLabels,
  type ProviderId,
  type ProviderLimits,
} from "@aqt/turnstash-api";
import { Button } from "@aqt/ui/components/button";
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
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronLeftIcon, ChevronRightIcon, GaugeIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Async, Pending, RequestFailure } from "../components/Async";
import { DataTable, Td, Th } from "../components/DataTable";
import { DrainChart, type LimitSelection, RemainingChart } from "../components/LimitChart";
import { Page, PageHead } from "../components/Page";
import { ProviderIcon } from "../components/ProviderIcon";
import { Section, surface } from "../components/Section";
import { quietControl, Segmented } from "../components/Segmented";
import { dayTime, int, moneyList, relativeTime, usd, weekdayTime } from "../format";
import {
  burnPerHour,
  type BurnMode,
  chartRowsOf,
  dayMs,
  drainBucketsOf,
  drainBurstsOf,
  futureFactors,
  type FutureUsage,
  hourMs,
  latestCostPerPercent,
  openWindowOf,
  paceOf,
  projectLimit,
  spanFor,
  useFirstOf,
  windowLabel,
} from "../limits-model";
import { limitDrainQuery, limitsQuery } from "../queries";

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
      to: new Date(selection.toMs + 60_000).toISOString(),
    }),
  );
  return (
    <div className="mt-3 rounded-xl bg-muted/40 p-3 sm:p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="font-medium">
          {dayTime(selection.fromMs)} to {dayTime(selection.toMs)}
          {drain.data !== undefined && (
            <span className="ml-2 font-normal text-muted-foreground">
              {usd(drain.data.costUsd)} at API rates, {int(drain.data.requests)} requests
            </span>
          )}
        </p>
        <Button size="icon-xs" variant="ghost" aria-label="Clear selection" onClick={onClear}>
          <XIcon />
        </Button>
      </div>
      {drain.isPending && <Pending />}
      {drain.isError && <RequestFailure error={drain.error} />}
      {drain.data !== undefined &&
        (drain.data.requests === 0 ? (
          <p className="text-muted-foreground">
            No recorded requests here. The usage came from a machine or app Turnstash does not
            collect.
          </p>
        ) : (
          <div className="grid gap-x-8 gap-y-3 lg:grid-cols-[3fr_2fr]">
            <ul className="flex min-w-0 flex-col gap-1">
              {drain.data.conversations.map((row) => (
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
              {drain.data.projects.slice(0, 8).map((row) => (
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
        ))}
    </div>
  );
};

const LimitCard = ({
  limits,
  nowMs,
  weekOffset,
  view,
  burnMode,
  future,
}: {
  readonly limits: ProviderLimits;
  readonly nowMs: number;
  readonly weekOffset: number;
  readonly view: LimitView;
  readonly burnMode: BurnMode;
  readonly future: FutureUsage;
}) => {
  const [minutes, setMinutes] = useState<number | null>(null);
  const [selection, setSelection] = useState<LimitSelection | null>(null);
  const series: LimitSeries | undefined =
    limits.series.find((candidate) => candidate.windowMinutes === minutes) ?? limits.series[0];
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
        note={`${limits.hits.length} limit hits`}
      >
        <p className="text-muted-foreground">
          Hits are recorded, but no usage reading yet. Run turnstash sync on a machine signed in to{" "}
          {name}.
        </p>
      </Section>
    );

  const open = openWindowOf(series);
  const remaining = open === null ? 100 : 100 - open.usedPercent;
  const span = spanFor(series.windowMinutes, weekOffset, nowMs);
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
  const bucketMs = short ? hourMs : 6 * hourMs;
  const buckets = drainBucketsOf(series.windows, span, bucketMs);
  const bursts = drainBurstsOf(series.windows).filter(
    (burst) => burst.toMs >= span.fromMs && burst.fromMs <= span.toMs,
  );
  const pace = paceOf(open, nowMs);
  const costPerPercent = latestCostPerPercent(series);
  const hits = limits.hits.filter(
    (hit) => hit.windowMinutes === null || hit.windowMinutes === series.windowMinutes,
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
              setSelection(null);
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
            {projection.emptyAtMs === null
              ? open === null
                ? "No window open"
                : "Not before reset"
              : weekdayTime(projection.emptyAtMs)}
          </Kpi>
          <Kpi label="Expires unused">
            {atReset === null ? "Nothing" : percent(atReset)}
            {atReset !== null && atReset > 0 && costPerPercent !== null && (
              <span className="ml-1.5 font-normal text-muted-foreground">
                {usd(atReset * costPerPercent)}
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
          {costPerPercent !== null && <Kpi label="1% buys">{usd(costPerPercent)}</Kpi>}
        </dl>
      </div>

      <div className="mt-4">
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
            label={`${name} drain rate per ${short ? "hour" : "six hours"}`}
          />
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full" style={{ background: color }} />
            Recorded
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-0.5 w-4"
              style={{
                background: `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)`,
              }}
            />
            Projected
          </span>
          {hits.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-destructive" />
              Limit hit
            </span>
          )}
        </div>
        <span>Drag across the chart to see what used the quota</span>
      </div>

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
  return days >= 1
    ? `Replaced ${Number(days.toFixed(1))} days early`
    : `Replaced ${Math.round(days * 24)} hours early`;
};

const WindowLedger = ({ providers }: { readonly providers: ReadonlyArray<ProviderLimits> }) => {
  const rows = providers
    .flatMap((limits) =>
      (limits.series[0]?.windows ?? [])
        .filter((window) => window.outcome !== "open")
        .map((window) => ({ provider: limits.provider, window })),
    )
    .toSorted((a, b) => Date.parse(b.window.endedAt) - Date.parse(a.window.endedAt))
    .slice(0, 16);
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
          ? `${moneyList(expiredTotal)} of plan cost expired unused`
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
            <Th numeric>1% bought</Th>
            <Th numeric>Plan cost expired</Th>
            <Th numeric>Ended</Th>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ provider, window }) => (
            <TableRow key={`${provider}:${window.startsAt}`}>
              <Td className="whitespace-nowrap">
                <span className="inline-flex items-center gap-2">
                  <ProviderIcon provider={provider} className="size-3.5" />
                  {dayLabel(Date.parse(window.startsAt))} to {dayLabel(Date.parse(window.endedAt))}
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
    </Section>
  );
};

export const UseFirstLine = ({
  providers,
  className,
}: {
  readonly providers: ReadonlyArray<ProviderLimits>;
  readonly className?: string;
}) => {
  const advice = useFirstOf(providers);
  if (advice === null) return null;
  return (
    <p className={cn("flex flex-wrap items-center gap-x-1.5", className)}>
      <ProviderIcon provider={advice.provider} className="size-3.5" />
      <span className="font-medium">Use {providerLabels[advice.provider]} first.</span>
      <span className="text-muted-foreground">
        {percent(advice.remaining)} left, resets {weekdayTime(advice.resetsAtMs)}, before{" "}
        {providerLabels[advice.thenProvider]} on {weekdayTime(advice.thenResetsAtMs)}.
      </span>
    </p>
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
  const [startedAtMs] = useState(() => Date.now());
  const [weekOffset, setWeekOffset] = useState(0);
  const [tab, setTab] = useState(allProviders);
  const [view, setView] = useState<LimitView>("remaining");
  const [burnMode, setBurnMode] = useState<BurnMode>("window");
  const [future, setFuture] = useState<FutureUsage>("same");
  const page = spanFor(10_080, weekOffset, startedAtMs);
  const report = useQuery(
    limitsQuery({
      from: new Date(page.fromMs).toISOString(),
      to: new Date(page.toMs).toISOString(),
    }),
  );
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
              <ProviderTabs providers={data.providers} value={tab} onChange={setTab} />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Segmented label="Chart" options={viewOptions} value={view} onChange={setView} />
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-muted-foreground">Burn rate</span>
                  <Segmented
                    label="Burn rate"
                    options={burnOptions}
                    value={burnMode}
                    onChange={setBurnMode}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-muted-foreground">Future usage</span>
                  <Select
                    items={futureOptions}
                    value={future}
                    onValueChange={(next) => {
                      if (next !== null) setFuture(next);
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
                <div className="ml-auto flex items-center gap-1">
                  <span className="mr-1.5 text-[13px] text-muted-foreground">
                    {dayLabel(page.fromMs)} to {dayLabel(page.toMs)}
                  </span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Earlier"
                    onClick={() => setWeekOffset((value) => value - 1)}
                  >
                    <ChevronLeftIcon />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={quietControl}
                    disabled={weekOffset === 0}
                    onClick={() => setWeekOffset(0)}
                  >
                    Today
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Later"
                    disabled={weekOffset >= 0}
                    onClick={() => setWeekOffset((value) => value + 1)}
                  >
                    <ChevronRightIcon />
                  </Button>
                </div>
              </div>
              <UseFirstLine
                providers={data.providers}
                className={cn(surface, "px-4 py-2.5 sm:px-6")}
              />
              {shown.map((limits) => (
                <LimitCard
                  key={limits.provider}
                  limits={limits}
                  nowMs={nowMs}
                  weekOffset={weekOffset}
                  view={view}
                  burnMode={burnMode}
                  future={future}
                />
              ))}
              <WindowLedger providers={shown} />
            </>
          );
        }}
      </Async>
    </Page>
  );
};

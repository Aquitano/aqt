import type { StatsFilter } from "@aqt/turnstash-api";
import { useQuery } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { FilterSelect } from "./components/FilterSelect";
import { PageHead } from "./components/Page";
import { Segmented } from "./components/Segmented";
import { type DayRange, isPeriodId, type PeriodId, periodRange, periods, ymd } from "./period";
import { isProvider, providerOptions } from "./providers";
import { machinesQuery, rangeFilter } from "./queries";

interface Selection {
  readonly period: PeriodId;
  readonly provider: string | null;
  readonly machineId: string | null;
}

interface Filters extends Selection {
  readonly today: Date;
  readonly timeZone: string;
  readonly range: DayRange | null;
  readonly stats: StatsFilter;
  readonly setPeriod: (period: PeriodId) => void;
  readonly setProvider: (provider: string | null) => void;
  readonly setMachineId: (machineId: string | null) => void;
}

const storageKey = "cb_filters";

const SavedSelection = Schema.fromJsonString(
  Schema.Struct({
    period: Schema.optionalKey(Schema.String),
    provider: Schema.optionalKey(Schema.NullOr(Schema.String)),
    machineId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);

const decodeSaved = Schema.decodeUnknownOption(SavedSelection);

const defaults: Selection = { period: "30d", provider: null, machineId: null };

const saved = (): Selection => {
  try {
    const stored = Option.getOrUndefined(decodeSaved(localStorage.getItem(storageKey)));
    if (stored === undefined) return defaults;
    return {
      period:
        stored.period !== undefined && isPeriodId(stored.period) ? stored.period : defaults.period,
      provider: stored.provider ?? null,
      machineId: stored.machineId ?? null,
    };
  } catch {
    // Storage may be blocked; the defaults apply.
    return defaults;
  }
};

const FiltersContext = createContext<Filters | null>(null);

const viewerClock = () => ({
  day: ymd(new Date()),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});

export const FiltersProvider = ({ children }: { readonly children: ReactNode }) => {
  const [selection, setSelection] = useState<Selection>(saved);
  const [clock, setClock] = useState(viewerClock);
  useEffect(() => {
    const refresh = () => {
      const next = viewerClock();
      setClock((current) =>
        current.day === next.day && current.timeZone === next.timeZone ? current : next,
      );
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  const update = useCallback((patch: Partial<Selection>) => {
    setSelection((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // The choice still applies for this page load.
      }
      return next;
    });
  }, []);
  const value = useMemo((): Filters => {
    const today = new Date(`${clock.day}T00:00:00`);
    const range = periodRange(selection.period, today);
    return {
      ...selection,
      today,
      timeZone: clock.timeZone,
      range,
      stats: {
        ...rangeFilter(range),
        timeZone: clock.timeZone,
        ...(selection.provider !== null && isProvider(selection.provider)
          ? { provider: selection.provider }
          : {}),
        ...(selection.machineId !== null ? { machineId: selection.machineId } : {}),
      },
      setPeriod: (period) => update({ period }),
      setProvider: (provider) => update({ provider }),
      setMachineId: (machineId) => update({ machineId }),
    };
  }, [selection, update, clock]);
  return <FiltersContext value={value}>{children}</FiltersContext>;
};

export const useFilters = (): Filters => {
  const filters = useContext(FiltersContext);
  if (filters === null) throw new Error("useFilters was called outside FiltersProvider");
  return filters;
};

// Pages hide the selectors that their subject already fixes, and a page that keeps its period and
// provider in the URL passes them as the selection.
export const FilterBar = ({
  title,
  note,
  selection,
  showProvider = true,
  showMachine = true,
  children,
}: {
  readonly title: string;
  readonly note?: ReactNode;
  readonly selection?: Pick<Filters, "period" | "provider" | "setPeriod" | "setProvider">;
  readonly showProvider?: boolean;
  readonly showMachine?: boolean;
  readonly children?: ReactNode;
}) => {
  const filters = useFilters();
  const { period, provider, setPeriod, setProvider } = selection ?? filters;
  const machines = useQuery(machinesQuery());
  return (
    <div className="flex flex-col gap-3.5">
      <PageHead title={title} note={note} />
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Period"
          options={periods.map((entry) => ({ value: entry.id, label: entry.label }))}
          value={period}
          onChange={setPeriod}
        />
        {showProvider && (
          <FilterSelect
            label="Provider"
            anyLabel="All providers"
            value={provider}
            options={providerOptions}
            onChange={setProvider}
          />
        )}
        {showMachine && (
          <FilterSelect
            label="Machine"
            anyLabel="All machines"
            value={filters.machineId}
            options={(machines.data ?? []).map((machine) => ({
              value: machine.id,
              label: machine.name,
            }))}
            onChange={filters.setMachineId}
          />
        )}
        {children}
      </div>
    </div>
  );
};

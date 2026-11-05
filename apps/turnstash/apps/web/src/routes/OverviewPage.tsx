import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { Async } from "../components/Async";
import { LimitsStrip } from "../components/LimitsStrip";
import { Page } from "../components/Page";
import { StatsView } from "../components/StatsView";
import { FilterBar, useFilters } from "../filters";
import { expiredByProvider } from "../limits-model";
import { dateBounds, heatmapRange } from "../period";
import { dailyQuery, limitsQuery, rangeFilter, statsQuery } from "../queries";
import { usePreviousOverall } from "../trend";

export const OverviewPage = () => {
  const filters = useFilters();
  const stats = useQuery(statsQuery(filters.stats));
  const previous = usePreviousOverall(filters.range, filters.stats);
  // The calendar keeps a year-long window whatever period is selected: its job is the long rhythm.
  const calendar = useQuery(
    dailyQuery({ ...filters.stats, ...rangeFilter(heatmapRange(filters.today)) }),
  );

  const bounds = filters.range === null ? null : dateBounds(filters.range);
  const limits = useQuery({
    ...limitsQuery(bounds ?? { from: new Date(0).toISOString() }),
    placeholderData: keepPreviousData,
  });
  const expired = expiredByProvider(
    limits.data?.providers ?? [],
    bounds === null ? null : { fromMs: Date.parse(bounds.from), toMs: Date.parse(bounds.to) },
  );

  return (
    <Page>
      <FilterBar title="Overview" note={stats.data?.range === null ? "all time" : undefined} />
      <LimitsStrip providers={limits.data?.providers ?? []} />
      <Async query={stats}>
        {(data) => (
          <StatsView
            stats={data}
            previous={previous}
            calendar={calendar.data ?? null}
            hideMachines={filters.machineId !== null}
            showSubscriptions
            {...(limits.isPlaceholderData || limits.data === undefined ? {} : { expired })}
          />
        )}
      </Async>
    </Page>
  );
};

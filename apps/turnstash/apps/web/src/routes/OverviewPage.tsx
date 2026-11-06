import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { isUnauthorized } from "../api";
import { Async, Pending, RequestFailure } from "../components/Async";
import { LimitsStrip } from "../components/LimitsStrip";
import { Page } from "../components/Page";
import { StatsView } from "../components/StatsView";
import { FilterBar, useFilters } from "../filters";
import { dateBounds, heatmapRange } from "../period";
import { dailyQuery, limitsOverviewQuery, rangeFilter, statsQuery } from "../queries";
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
    ...limitsOverviewQuery(bounds ?? { from: new Date(0).toISOString() }),
    placeholderData: keepPreviousData,
  });
  const unauthorized = [stats, limits, calendar].flatMap((query) =>
    query.isError && isUnauthorized(query.error) ? [query.error] : [],
  )[0];
  if (unauthorized !== undefined)
    return (
      <Page>
        <FilterBar title="Overview" />
        <RequestFailure error={unauthorized} />
      </Page>
    );
  const expired = new Map(
    (limits.data?.providers ?? []).map((provider) => [provider.provider, provider.expiredValue]),
  );

  return (
    <Page>
      <FilterBar title="Overview" note={stats.data?.range === null ? "all time" : undefined} />
      {stats.isSuccess && limits.isPending && <Pending />}
      {!stats.isError && limits.isError && (
        <RequestFailure
          error={limits.error}
          stale={limits.data !== undefined}
          onRetry={() => {
            void limits.refetch();
          }}
          retrying={limits.isFetching}
        />
      )}
      <LimitsStrip providers={limits.data?.providers ?? []} />
      <Async query={stats}>
        {(data) => (
          <StatsView
            stats={data}
            previous={previous}
            calendar={calendar.data ?? null}
            hideMachines={filters.machineId !== null}
            showSubscriptions
            {...(limits.isError || limits.isPlaceholderData || limits.data === undefined
              ? {}
              : { expired })}
          />
        )}
      </Async>
    </Page>
  );
};

import { useQuery } from "@tanstack/react-query";

import { Async } from "../components/Async";
import { Page } from "../components/Page";
import { StatsView } from "../components/StatsView";
import { FilterBar, useFilters } from "../filters";
import { heatmapRange } from "../period";
import { dailyQuery, rangeFilter, statsQuery } from "../queries";
import { usePreviousOverall } from "../trend";

export const OverviewPage = () => {
  const filters = useFilters();
  const stats = useQuery(statsQuery(filters.stats));
  const previous = usePreviousOverall(filters.range, filters.stats);
  // The calendar keeps a year-long window whatever period is selected: its job is the long rhythm.
  const calendar = useQuery(
    dailyQuery({ ...filters.stats, ...rangeFilter(heatmapRange(filters.today)) }),
  );

  return (
    <Page>
      <FilterBar title="Overview" note={stats.data?.range === null ? "all time" : undefined} />
      <Async query={stats}>
        {(data) => (
          <StatsView
            stats={data}
            previous={previous}
            calendar={calendar.data ?? null}
            hideMachines={filters.machineId !== null}
            showSubscriptions
          />
        )}
      </Async>
    </Page>
  );
};

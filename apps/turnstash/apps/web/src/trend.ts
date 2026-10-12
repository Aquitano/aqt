import type { Overall, StatsFilter } from "@aqt/turnstash-api";
import { useQuery } from "@tanstack/react-query";

import type { DayRange } from "./period";
import { previousRange } from "./period";
import { overallQuery, rangeFilter } from "./queries";

/**
 * Totals for the window of the same length immediately before `range`, which
 * the tiles render as trend badges. All-time has no previous window, and the
 * disabled query would otherwise read whatever sits under the unfiltered
 * totals key, so it returns null there instead.
 */
export const usePreviousOverall = (range: DayRange | null, filter: StatsFilter): Overall | null => {
  const previous = useQuery({
    ...overallQuery(range === null ? {} : { ...filter, ...rangeFilter(previousRange(range)) }),
    enabled: range !== null,
  });
  return range === null ? null : (previous.data ?? null);
};

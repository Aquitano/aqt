import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { Async } from "../components/Async";
import { Card } from "../components/Card";
import { CommitList } from "../components/CommitList";
import { Page } from "../components/Page";
import { StatsView } from "../components/StatsView";
import { FilterBar, useFilters } from "../filters";
import { projectQuery } from "../queries";
import { usePreviousOverall } from "../trend";

export const ProjectPage = () => {
  const { key } = useParams({ from: "/projects/$key" });
  const filters = useFilters();
  const detail = useQuery(projectQuery(key, filters.range, filters.timeZone));
  const previous = usePreviousOverall(filters.range, { projectKey: key });

  return (
    <Page>
      <FilterBar
        title={key}
        note={detail.data?.projectPath ?? undefined}
        showProvider={false}
        showMachine={false}
      />
      <Async query={detail}>
        {(data) => (
          <>
            <StatsView stats={data.stats} previous={previous} calendar={null} hideProjects />
            {data.commits.length > 0 && (
              <Card title="Recent commits" note="linked to conversations by time window">
                <CommitList commits={data.commits} showConversation />
              </Card>
            )}
          </>
        )}
      </Async>
    </Page>
  );
};

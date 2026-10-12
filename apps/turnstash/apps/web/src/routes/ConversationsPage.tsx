import type { ConversationListQuery } from "@aqt/turnstash-api";
import { Button } from "@aqt/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@aqt/ui/components/empty";
import { Input } from "@aqt/ui/components/input";
import { Spinner } from "@aqt/ui/components/spinner";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { MessagesSquareIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Pending, RequestFailure } from "../components/Async";
import { Card } from "../components/Card";
import { ConversationsTable } from "../components/ConversationsTable";
import { FilterSelect } from "../components/FilterSelect";
import { Page } from "../components/Page";
import { FilterBar, useFilters } from "../filters";
import { conversationPagesQuery, projectsQuery } from "../queries";

export const ConversationsPage = () => {
  const filters = useFilters();
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const projects = useQuery(projectsQuery(filters.range));

  const query = useMemo(
    (): ConversationListQuery => ({
      ...filters.stats,
      ...(projectKey !== null ? { projectKey } : {}),
      ...(q !== "" ? { q } : {}),
      limit: 50,
    }),
    [filters.stats, projectKey, q],
  );
  const pages = useInfiniteQuery(conversationPagesQuery(query));
  const rows = useMemo(() => (pages.data?.pages ?? []).flatMap((page) => page.items), [pages.data]);
  const apply = () => setQ(text.trim());

  return (
    <Page>
      <FilterBar title="Conversations">
        <FilterSelect
          label="Project"
          anyLabel="All projects"
          value={projectKey}
          options={(projects.data ?? []).map((project) => ({
            value: project.projectKey,
            label: project.projectKey,
          }))}
          onChange={setProjectKey}
        />
        <Input
          aria-label="Title contains"
          placeholder="Title contains"
          className="h-8 w-36 md:text-[13px]"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") apply();
          }}
        />
        <Button size="sm" variant="outline" onClick={apply}>
          Filter
        </Button>
      </FilterBar>

      {pages.isPending && <Pending />}
      {pages.isError && <RequestFailure error={pages.error} />}
      {pages.isSuccess &&
        (rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessagesSquareIcon />
              </EmptyMedia>
              <EmptyTitle>No conversations match</EmptyTitle>
              <EmptyDescription>Widen the period or clear a filter.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card
            title="Conversations"
            note={`${rows.length} loaded${pages.hasNextPage ? ", more available" : ""}`}
          >
            <ConversationsTable rows={rows} />
            {pages.hasNextPage && (
              <div className="flex items-center gap-2 pt-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pages.isFetchingNextPage}
                  onClick={() => void pages.fetchNextPage()}
                >
                  {pages.isFetchingNextPage && <Spinner data-icon="inline-start" />}
                  Load 50 more
                </Button>
              </div>
            )}
          </Card>
        ))}
    </Page>
  );
};

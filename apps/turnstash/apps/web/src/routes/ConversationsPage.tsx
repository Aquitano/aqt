import type { ConversationListQuery } from "@aqt/turnstash-api";
import { Button, Empty, Input } from "@cloudflare/kumo";
import { ChatsIcon } from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ChangeEvent } from "react";

import { Pending, RequestFailure } from "../components/Async";
import { Card } from "../components/Card";
import { ConversationsTable } from "../components/ConversationsTable";
import { FilterSelect } from "../components/FilterSelect";
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
    <main className="main">
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
          size="sm"
          aria-label="Title contains"
          placeholder="Title contains"
          value={text}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") apply();
          }}
        />
        <Button size="sm" onClick={apply}>
          Filter
        </Button>
      </FilterBar>

      {pages.isPending && <Pending />}
      {pages.isError && <RequestFailure error={pages.error} />}
      {pages.isSuccess &&
        (rows.length === 0 ? (
          <Empty
            size="lg"
            icon={<ChatsIcon size={48} />}
            title="No conversations match"
            description="Widen the period or clear a filter."
          />
        ) : (
          <Card
            title="Conversations"
            note={`${rows.length} loaded${pages.hasNextPage ? ", more available" : ""}`}
          >
            <ConversationsTable rows={rows} />
            {pages.hasNextPage && (
              <div className="table-foot">
                <Button
                  size="sm"
                  loading={pages.isFetchingNextPage}
                  onClick={() => void pages.fetchNextPage()}
                >
                  Load 50 more
                </Button>
              </div>
            )}
          </Card>
        ))}
    </main>
  );
};

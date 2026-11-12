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
import { useNavigate, useSearch } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { isUnauthorized } from "../api";
import { Pending, RequestFailure } from "../components/Async";
import { ConversationsTable } from "../components/ConversationsTable";
import { FilterSelect } from "../components/FilterSelect";
import { Page } from "../components/Page";
import { Section } from "../components/Section";
import { FilterBar, useFilters } from "../filters";
import { conversationPagesQuery, projectsQuery } from "../queries";
import type { ConversationListSearch } from "../search-state";

export const ConversationsPage = () => {
  const filters = useFilters();
  const state = useSearch({ from: "/conversations" });
  const navigate = useNavigate({ from: "/conversations" });
  const projectKey = state.projectKey ?? null;
  const q = state.q ?? "";
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (titleInput.current !== null && titleInput.current.value !== q) titleInput.current.value = q;
  }, [q]);
  const update = (patch: ConversationListSearch) =>
    void navigate({ to: "/conversations", search: { ...state, ...patch }, resetScroll: false });
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
  const unauthorized = pages.isError && isUnauthorized(pages.error);

  return (
    <Page>
      <FilterBar title="Conversations" note="Archived sessions from every enrolled machine.">
        <FilterSelect
          label="Project"
          anyLabel="All projects"
          value={projectKey}
          options={[
            ...new Set([
              ...(projects.isError && isUnauthorized(projects.error)
                ? []
                : (projects.data ?? [])
              ).map((project) => project.projectKey),
              ...(projectKey === null ? [] : [projectKey]),
            ]),
          ].map((key) => ({ value: key, label: key }))}
          onChange={(value) => update({ projectKey: value ?? undefined })}
        />
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            update({ q: titleInput.current?.value.trim() || undefined });
          }}
        >
          <Input
            ref={titleInput}
            name="q"
            aria-label="Title contains"
            placeholder="Title contains"
            className="h-8 w-36"
            maxLength={1024}
            defaultValue={q}
          />
          <Button size="sm" variant="outline" type="submit">
            Filter
          </Button>
        </form>
      </FilterBar>

      {pages.isPending && <Pending />}
      {pages.isError && (
        <div className="flex flex-col items-start gap-2">
          <RequestFailure error={pages.error} stale={pages.data !== undefined && !unauthorized} />
          {!unauthorized && !pages.isFetchNextPageError && (
            <Button
              size="sm"
              variant="outline"
              disabled={pages.isFetching}
              onClick={() => void pages.refetch()}
            >
              Retry loading conversations
            </Button>
          )}
        </div>
      )}
      {!unauthorized &&
        pages.data !== undefined &&
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
          <Section
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
                  {pages.isFetchNextPageError ? "Retry loading conversations" : "Load 50 more"}
                </Button>
              </div>
            )}
          </Section>
        ))}
    </Page>
  );
};

import type { ConversationListQuery } from "@aqt/turnstash-api";
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
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@aqt/ui/components/input-group";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { MessagesSquareIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { isUnauthorized } from "../api";
import { Pending, RequestFailure } from "../components/Async";
import { ConversationsTable } from "../components/ConversationsTable";
import { FilterSelect } from "../components/FilterSelect";
import { type ActiveFilter, FilterChips, LoadMore } from "../components/ListControls";
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
  const active: ReadonlyArray<ActiveFilter> = [
    ...(q === ""
      ? []
      : [{ key: "q", label: `Title contains "${q}"`, onClear: () => update({ q: undefined }) }]),
    ...(projectKey === null
      ? []
      : [
          {
            key: "project",
            label: `Project ${projectKey}`,
            onClear: () => update({ projectKey: undefined }),
          },
        ]),
  ];
  const clearAll = () => update({ q: undefined, projectKey: undefined });

  return (
    <Page>
      <FilterBar
        title="Conversations"
        note="Archived sessions from every enrolled machine, newest first."
        search={
          <form
            role="search"
            className="w-full max-w-xl"
            onSubmit={(event) => {
              event.preventDefault();
              update({ q: titleInput.current?.value.trim() || undefined });
            }}
          >
            <InputGroup className="h-9">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                ref={titleInput}
                name="q"
                aria-label="Title contains"
                placeholder="Filter by title"
                maxLength={1024}
                defaultValue={q}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton type="submit">Filter</InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
        }
      >
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
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessagesSquareIcon />
              </EmptyMedia>
              <EmptyTitle>No conversations match</EmptyTitle>
              <EmptyDescription>
                {active.length > 0
                  ? "Nothing in this period matches these filters."
                  : "Nothing was recorded in this period. Choose a longer period."}
              </EmptyDescription>
            </EmptyHeader>
            {active.length > 0 && (
              <EmptyContent>
                <FilterChips filters={active} onClearAll={clearAll} />
                <Button size="sm" variant="outline" onClick={clearAll}>
                  Clear filters
                </Button>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          <Section
            title="Results"
            note={`${rows.length}${pages.hasNextPage ? "+" : ""} ${rows.length === 1 ? "conversation" : "conversations"}`}
            action={<FilterChips filters={active} onClearAll={clearAll} />}
          >
            <ConversationsTable rows={rows} />
            {pages.hasNextPage && (
              <LoadMore
                shown={rows.length}
                noun="conversations"
                loading={pages.isFetchingNextPage}
                failed={pages.isFetchNextPageError}
                onLoad={() => void pages.fetchNextPage()}
                label="Load 50 more"
              />
            )}
          </Section>
        ))}
    </Page>
  );
};

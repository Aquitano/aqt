import type { SearchQuery } from "@aqt/turnstash-api";
import { Badge } from "@aqt/ui/components/badge";
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
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { SearchIcon, SearchXIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { isUnauthorized } from "../api";
import { Async } from "../components/Async";
import { FilterSelect } from "../components/FilterSelect";
import { type ActiveFilter, FilterChips } from "../components/ListControls";
import { Page } from "../components/Page";
import { ProviderBadge } from "../components/ProviderBadge";
import { Section } from "../components/Section";
import { Snippet } from "../components/Snippet";
import { FilterBar, useFilters } from "../filters";
import { dateTime, shortId } from "../format";
import { periodRange, periods } from "../period";
import { isProvider } from "../providers";
import { projectsQuery, rangeFilter, searchQuery } from "../queries";
import { roles, type SearchState } from "../search-state";

const resultLimit = 50;

export const SearchPage = () => {
  const state: SearchState = useSearch({ from: "/search" });
  const navigate = useNavigate({ from: "/search" });
  const term = state.q ?? "";
  const period = state.period ?? "30d";
  const { today } = useFilters();
  const textInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (textInput.current !== null && textInput.current.value !== term)
      textInput.current.value = term;
  }, [term]);
  const update = (patch: Partial<SearchState>) =>
    void navigate({ to: "/search", search: { ...state, ...patch } });
  const projects = useQuery(projectsQuery(null));

  const query = useMemo((): SearchQuery => {
    return {
      q: term,
      ...rangeFilter(periodRange(period, today)),
      ...(state.provider === undefined ? {} : { provider: state.provider }),
      ...(state.projectKey === undefined ? {} : { projectKey: state.projectKey }),
      ...(state.role === undefined ? {} : { role: state.role }),
      limit: resultLimit,
    };
  }, [term, period, today, state.provider, state.projectKey, state.role]);
  const results = useQuery(searchQuery(query));
  const periodLabel = (periods.find((entry) => entry.id === period)?.label ?? "").toLowerCase();
  const narrowed: ReadonlyArray<ActiveFilter> = [
    ...(state.projectKey === undefined
      ? []
      : [
          {
            key: "project",
            label: `Project ${state.projectKey}`,
            onClear: () => update({ projectKey: undefined }),
          },
        ]),
    ...(state.role === undefined
      ? []
      : [{ key: "role", label: `Role ${state.role}`, onClear: () => update({ role: undefined }) }]),
  ];
  const filtered =
    period !== "all" ||
    state.provider !== undefined ||
    state.projectKey !== undefined ||
    state.role !== undefined;

  return (
    <Page>
      <FilterBar
        title="Search"
        note="Full-text search over messages and their tool inputs, such as commands and file paths."
        showMachine={false}
        selection={{
          period,
          provider: state.provider ?? null,
          setPeriod: (value) => update({ period: value }),
          setProvider: (value) => update({ provider: isProvider(value) ? value : undefined }),
        }}
        search={
          <form
            role="search"
            className="w-full max-w-2xl"
            onSubmit={(event) => {
              event.preventDefault();
              update({ q: textInput.current?.value.trim() ?? "" });
            }}
          >
            <InputGroup className="h-10">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Search words"
                placeholder="Search every transcript"
                ref={textInput}
                name="q"
                defaultValue={term}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton type="submit" variant="default">
                  Search
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
        }
      >
        <FilterSelect
          label="Project"
          anyLabel="All projects"
          value={state.projectKey ?? null}
          options={[
            ...new Set([
              ...(projects.isError && isUnauthorized(projects.error)
                ? []
                : (projects.data ?? [])
              ).map((project) => project.projectKey),
              ...(state.projectKey === undefined ? [] : [state.projectKey]),
            ]),
          ].map((projectKey) => ({ value: projectKey, label: projectKey }))}
          onChange={(value) => update({ projectKey: value ?? undefined })}
        />
        <FilterSelect
          label="Message role"
          anyLabel="All roles"
          className="w-32"
          value={state.role ?? null}
          options={roles.map((role) => ({ value: role, label: role }))}
          onChange={(value) => update({ role: roles.find((role) => role === value) })}
        />
      </FilterBar>

      {term === "" && (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchIcon />
            </EmptyMedia>
            <EmptyTitle>Search the archive</EmptyTitle>
            <EmptyDescription>
              Type words and press Enter. Messages from the selected period are searched, including
              the shell commands and file paths the agents used.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {term !== "" && (
        <Async query={results}>
          {(data) =>
            data.hits.length === 0 ? (
              <Empty className="border border-dashed">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SearchXIcon />
                  </EmptyMedia>
                  <EmptyTitle>Nothing matched "{term}"</EmptyTitle>
                  <EmptyDescription>
                    Searched {periodLabel}
                    {filtered && period === "all" ? " with filters" : ""}. Try fewer or different
                    words{filtered ? ", or search all time without filters" : ""}.
                  </EmptyDescription>
                </EmptyHeader>
                {filtered && (
                  <EmptyContent>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        update({
                          period: "all",
                          provider: undefined,
                          projectKey: undefined,
                          role: undefined,
                        })
                      }
                    >
                      Search all time without filters
                    </Button>
                  </EmptyContent>
                )}
              </Empty>
            ) : (
              <Section
                title={`Results for "${term}"`}
                note={`${data.hits.length === resultLimit ? "top " : ""}${data.hits.length} ${data.hits.length === 1 ? "match" : "matches"}, ${periodLabel}`}
                action={
                  <FilterChips
                    filters={narrowed}
                    onClearAll={() => update({ projectKey: undefined, role: undefined })}
                  />
                }
              >
                <ol className="flex flex-col">
                  {data.hits.map((hit) => (
                    <li
                      className="flex min-w-0 flex-col gap-1.5 border-b py-3.5 first:pt-1 last:border-b-0 last:pb-1"
                      key={hit.messageId}
                    >
                      <Link
                        to="/conversations/$id"
                        params={{ id: hit.conversationId }}
                        search={{ message: hit.messageKey, q: term }}
                        className="w-fit max-w-full truncate font-medium underline-offset-2 outline-none hover:underline hover:decoration-primary focus-visible:underline"
                      >
                        {hit.title ?? hit.projectKey ?? shortId(hit.conversationId, 12)}
                      </Link>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <ProviderBadge provider={hit.provider} />
                        <Badge variant="secondary">{hit.role}</Badge>
                        {hit.projectKey !== null && hit.title !== null && (
                          <span className="max-w-48 truncate">{hit.projectKey}</span>
                        )}
                        <span>{dateTime(hit.createdAt)}</span>
                      </div>
                      <Snippet text={hit.snippet} />
                    </li>
                  ))}
                </ol>
              </Section>
            )
          }
        </Async>
      )}
    </Page>
  );
};

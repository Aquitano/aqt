import type { SearchQuery } from "@aqt/turnstash-api";
import { Badge } from "@aqt/ui/components/badge";
import {
  Empty,
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
import { SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Pending, RequestFailure } from "../components/Async";
import { FilterSelect } from "../components/FilterSelect";
import { Page } from "../components/Page";
import { ProviderBadge } from "../components/ProviderBadge";
import { Section } from "../components/Section";
import { Snippet } from "../components/Snippet";
import { FilterBar, useFilters } from "../filters";
import { dateTime, shortId } from "../format";
import { periodRange } from "../period";
import { isProvider } from "../providers";
import { projectsQuery, rangeFilter, searchQuery } from "../queries";
import { roles, type SearchState } from "../search-state";

export const SearchPage = () => {
  const state = useSearch({ from: "/search" });
  const navigate = useNavigate({ from: "/search" });
  const term = state.q ?? "";
  const period = state.period ?? "30d";
  const { today } = useFilters();
  const [text, setText] = useState(term);
  useEffect(() => setText(term), [term]);
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
      limit: 50,
    };
  }, [term, period, today, state.provider, state.projectKey, state.role]);
  const results = useQuery(searchQuery(query));

  return (
    <Page>
      <FilterBar
        title="Search"
        showMachine={false}
        selection={{
          period,
          provider: state.provider ?? null,
          setPeriod: (value) => update({ period: value }),
          setProvider: (value) => update({ provider: isProvider(value) ? value : undefined }),
        }}
      >
        <FilterSelect
          label="Project"
          anyLabel="All projects"
          value={state.projectKey ?? null}
          options={[
            ...new Set([
              ...(projects.data ?? []).map((project) => project.projectKey),
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
        <form
          role="search"
          className="flex max-w-120 min-w-60 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            update({ q: text.trim() });
          }}
        >
          <InputGroup className="h-8">
            <InputGroupInput
              aria-label="Search words"
              placeholder="Search every transcript"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton type="submit">
                <SearchIcon />
                Search
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </FilterBar>

      {term === "" && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchIcon />
            </EmptyMedia>
            <EmptyTitle>Search the archive</EmptyTitle>
            <EmptyDescription>
              Type words and press Enter. Every message in the period is searched.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {term !== "" && results.isPending && <Pending />}
      {results.isError && <RequestFailure error={results.error} />}
      {term !== "" && results.isSuccess && (
        <Section title={`Results for ${term}`} note={`${results.data.hits.length} hits`}>
          {results.data.hits.length === 0 && (
            <p className="py-3 text-xs text-muted-foreground">
              Nothing matched. Try fewer or different words.
            </p>
          )}
          {results.data.hits.map((hit) => (
            <div
              className="flex flex-col gap-1.5 border-b py-3 last:border-b-0"
              key={hit.messageId}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  to="/conversations/$id"
                  params={{ id: hit.conversationId }}
                  search={{ message: hit.messageKey, q: term }}
                  className="font-medium underline-offset-2 outline-none hover:underline hover:decoration-primary focus-visible:underline"
                >
                  {hit.title ?? hit.projectKey ?? shortId(hit.conversationId, 12)}
                </Link>
                <ProviderBadge provider={hit.provider} />
                <Badge variant="secondary">{hit.role}</Badge>
                <span className="text-xs text-muted-foreground">{dateTime(hit.createdAt)}</span>
              </div>
              <Snippet text={hit.snippet} />
            </div>
          ))}
        </Section>
      )}
    </Page>
  );
};

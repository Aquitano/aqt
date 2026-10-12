import type { SearchQuery } from "@aqt/turnstash-api";
import { Badge, Button, Empty, Input } from "@cloudflare/kumo";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";

import { Pending, RequestFailure } from "../components/Async";
import { Card } from "../components/Card";
import { FilterSelect } from "../components/FilterSelect";
import { ProviderBadge } from "../components/ProviderBadge";
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
    <main className="main">
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
          value={state.role ?? null}
          options={roles.map((role) => ({ value: role, label: role }))}
          onChange={(value) => update({ role: roles.find((role) => role === value) })}
        />
        <Input
          size="sm"
          aria-label="Search words"
          className="search-field"
          placeholder="Search every transcript"
          value={text}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") update({ q: text.trim() });
          }}
        />
        <Button size="sm" icon={<MagnifyingGlassIcon />} onClick={() => update({ q: text.trim() })}>
          Search
        </Button>
      </FilterBar>

      {term === "" && (
        <Empty
          size="lg"
          icon={<MagnifyingGlassIcon size={48} />}
          title="Search the archive"
          description="Type words and press Enter. Every message in the period is searched."
        />
      )}
      {term !== "" && results.isPending && <Pending />}
      {results.isError && <RequestFailure error={results.error} />}
      {term !== "" && results.isSuccess && (
        <Card title={`Results for ${term}`} note={`${results.data.hits.length} hits`}>
          {results.data.hits.length === 0 && (
            <span className="card-note">Nothing matched. Try fewer or different words.</span>
          )}
          {results.data.hits.map((hit) => (
            <div className="result" key={hit.messageId}>
              <div className="row">
                <Link
                  to="/conversations/$id"
                  params={{ id: hit.conversationId }}
                  search={{ message: hit.messageKey, q: term }}
                >
                  {hit.title ?? hit.projectKey ?? shortId(hit.conversationId, 12)}
                </Link>
                <ProviderBadge provider={hit.provider} />
                <Badge variant="neutral">{hit.role}</Badge>
                <span className="card-note">{dateTime(hit.createdAt)}</span>
              </div>
              <Snippet text={hit.snippet} />
            </div>
          ))}
        </Card>
      )}
    </main>
  );
};

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Landmark } from "lucide-react";
import { useEffect, useRef } from "react";

import { DetailPane } from "@/components/detail-pane";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getStats } from "@/lib/api";
import {
  isView,
  navigate,
  readSearch,
  readSelection,
  select,
  useLocation,
  writeSearch,
  writeSelection,
  type View,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { AttachmentsView } from "@/views/attachments";
import { ALL_SOURCES, BrowseView } from "@/views/browse";
import { CollectionsView } from "@/views/collections";
import { ContactsView } from "@/views/contacts";
import { ImportsView } from "@/views/imports";
import { LibraryView, ActivityView } from "@/views/library";
import { MediaFilesView } from "@/views/media-files";
import { SearchView } from "@/views/search";
import { StatsView } from "@/views/stats";

const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false } },
});

function setView(view: View) {
  navigate((params) => {
    params.set("view", view);
    writeSelection(params, null);
  });
}

function Shell() {
  const location = useLocation();
  const url = new URLSearchParams(location);
  const requestedView =
    url.get("view") || (url.has("message") || url.has("q") ? "search" : "library");
  const view = isView(requestedView) ? requestedView : "search";
  const selection = readSelection(url);
  const searchParams = readSearch(url);
  const browseSource = url.get("browseSource") || ALL_SOURCES;
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);

  const statsQ = useQuery({ queryKey: ["stats"], queryFn: getStats });
  const stats = statsQ.data ?? [];
  const total = stats.reduce((a, s) => a + s.messages, 0);

  // Global keys: "/" focuses search, arrows (or j/k) walk the list pane.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const field =
        target !== null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
          ? target
          : null;
      if (e.key === "/" && field === null) {
        e.preventDefault();
        setView("search");
        requestAnimationFrame(() => searchRef.current?.focus());
        return;
      }
      const down = e.key === "ArrowDown" || (e.key === "j" && field === null);
      const up = e.key === "ArrowUp" || (e.key === "k" && field === null);
      if (!down && !up) return;
      if (field !== null && field !== searchRef.current) return;
      if (target?.closest('[role="combobox"], [role="listbox"], [role="option"]')) return;
      const rows = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-row]"));
      if (!rows.length) return;
      const cursor = rows.findIndex(
        (row) => row === rowRef.current && row.dataset.selected !== undefined,
      );
      const cur = cursor >= 0 ? cursor : rows.findIndex((r) => r.dataset.selected !== undefined);
      const next = rows[Math.min(rows.length - 1, Math.max(0, cur + (down ? 1 : -1)))];
      if (!next) return;
      e.preventDefault();
      rowRef.current = next;
      next.click();
      next.scrollIntoView({ block: "nearest" });
    };
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Element) {
        const row = event.target.closest<HTMLButtonElement>("button[data-row]");
        if (row) rowRef.current = row;
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b bg-card px-4 py-3">
        <h1 className="flex shrink-0 items-center gap-2 text-sm font-semibold tracking-wide">
          <Landmark className="size-4 text-primary" />
          <span>aqt-bank</span>
        </h1>
        <div className="order-3 min-w-0 basis-full overflow-x-auto lg:order-none lg:flex-1 lg:basis-auto">
          <Tabs
            value={view === "attachments" ? "media-files" : view}
            onValueChange={(value) => {
              if (isView(value)) setView(value);
            }}
          >
            <TabsList className="w-max">
              {(
                [
                  { value: "library", label: "Library" },
                  { value: "activity", label: "Activity" },
                  { value: "collections", label: "Collections" },
                  { value: "search", label: "Search" },
                  { value: "browse", label: "Messages" },
                  { value: "media-files", label: "Files" },
                  { value: "contacts", label: "Contacts" },
                  { value: "imports", label: "Imports" },
                  { value: "stats", label: "Sources" },
                ] as const
              ).map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <div className="ml-auto text-xs text-muted-foreground tabular-nums">
          {statsQ.isError
            ? "Archive unavailable"
            : total
              ? `${total.toLocaleString("en")} messages`
              : ""}
        </div>
      </header>

      {view === "imports" ? (
        <ImportsView />
      ) : view === "stats" ? (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <StatsView
            stats={stats}
            onOpenSource={(s) => {
              navigate((params) => {
                params.set("browseSource", s);
                params.set("view", "browse");
              });
            }}
          />
        </main>
      ) : (
        <main className="flex min-h-0 flex-1">
          <div
            className={cn(
              "min-h-0 w-full flex-col border-r md:flex md:w-[44%] md:max-w-[560px] md:min-w-[320px]",
              selection ? "hidden" : "flex",
            )}
          >
            {view === "library" && <LibraryView selection={selection} />}
            {view === "activity" && <ActivityView selection={selection} />}
            {view === "collections" && <CollectionsView selection={selection} />}
            {(view === "attachments" || view === "media-files") && (
              <Tabs
                className="shrink-0 px-4 pt-4"
                value={view}
                onValueChange={(value) => {
                  if (isView(value)) setView(value);
                }}
              >
                <TabsList>
                  <TabsTrigger value="media-files">Library files</TabsTrigger>
                  <TabsTrigger value="attachments">Message attachments</TabsTrigger>
                </TabsList>
              </Tabs>
            )}
            {view === "media-files" && <MediaFilesView selection={selection} />}
            {view === "search" && (
              <SearchView
                key={JSON.stringify(searchParams)}
                params={searchParams}
                onSearch={(search) =>
                  navigate((params) => {
                    writeSearch(params, search);
                    writeSelection(params, null);
                  })
                }
                stats={stats}
                selection={selection}
                onSelect={select}
                searchRef={searchRef}
              />
            )}
            {view === "browse" && (
              <BrowseView
                stats={stats}
                selection={selection}
                onSelect={select}
                source={browseSource}
                onSourceChange={(source) =>
                  navigate((params) => params.set("browseSource", source))
                }
              />
            )}
            {view === "attachments" && <AttachmentsView onSelect={select} />}
            {view === "contacts" && <ContactsView selection={selection} onSelect={select} />}
          </div>
          <div
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex",
              selection ? "flex" : "hidden",
            )}
          >
            <div className="shrink-0 border-b p-2 md:hidden">
              <Button variant="ghost" size="sm" onClick={() => select(null)}>
                <ArrowLeft data-icon="inline-start" />
                Back to results
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <DetailPane selection={selection} />
            </div>
          </div>
        </main>
      )}
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={client}>
      <Shell />
    </QueryClientProvider>
  );
}

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Landmark } from "lucide-react";
import { useEffect, useRef } from "react";

import { DetailPane } from "@/components/detail-pane";
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
import { AttachmentsView } from "@/views/attachments";
import { ALL_SOURCES, BrowseView } from "@/views/browse";
import { ContactsView } from "@/views/contacts";
import { ImportsView } from "@/views/imports";
import { SearchView } from "@/views/search";
import { StatsView } from "@/views/stats";

const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false } },
});

function setView(view: View) {
  navigate((params) => params.set("view", view));
}

function Shell() {
  const location = useLocation();
  const url = new URLSearchParams(location);
  const requestedView = url.get("view") || "search";
  const view = isView(requestedView) ? requestedView : "search";
  const selection = readSelection(url);
  const searchParams = readSearch(url);
  const browseSource = url.get("browseSource") || ALL_SOURCES;
  const searchRef = useRef<HTMLInputElement>(null);

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
      const cur = rows.findIndex((r) => r.dataset.selected !== undefined);
      const next = rows[Math.min(rows.length - 1, Math.max(0, cur + (down ? 1 : -1)))];
      if (!next) return;
      e.preventDefault();
      next.click();
      next.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-5 border-b bg-card px-4 py-2">
        <h1 className="flex items-center gap-1.5 text-sm font-semibold tracking-wide">
          <Landmark className="size-4 text-primary" />
          <span>
            <span className="text-primary">aqt</span>-bank
          </span>
        </h1>
        <Tabs
          value={view}
          onValueChange={(v) => {
            if (isView(v)) setView(v);
          }}
        >
          <TabsList className="h-8">
            <TabsTrigger value="search" className="text-xs">
              Search
            </TabsTrigger>
            <TabsTrigger value="browse" className="text-xs">
              Browse
            </TabsTrigger>
            <TabsTrigger value="contacts" className="text-xs">
              Contacts
            </TabsTrigger>
            <TabsTrigger value="attachments" className="text-xs">
              Files
            </TabsTrigger>
            <TabsTrigger value="imports" className="text-xs">
              Imports
            </TabsTrigger>
            <TabsTrigger value="stats" className="text-xs">
              Stats
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto text-xs text-muted-foreground/70 tabular-nums">
          {statsQ.isError
            ? "archive unreachable"
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
          <div className="flex w-[44%] max-w-[560px] min-w-[380px] flex-col border-r">
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
          <div className="min-h-0 flex-1 overflow-hidden">
            <DetailPane selection={selection} />
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

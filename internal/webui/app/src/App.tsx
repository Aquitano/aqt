import { useEffect, useRef, useState } from "react"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { Landmark } from "lucide-react"
import { getStats } from "@/lib/api"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DetailPane, type Selection } from "@/components/detail-pane"
import { SearchView } from "@/views/search"
import { ALL_SOURCES, BrowseView } from "@/views/browse"
import { ContactsView } from "@/views/contacts"
import { StatsView } from "@/views/stats"

const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false } },
})

type View = "search" | "browse" | "contacts" | "stats"

function Shell() {
  const [view, setView] = useState<View>("search")
  const [selection, setSelection] = useState<Selection>(null)
  const [browseSource, setBrowseSource] = useState(ALL_SOURCES)
  const searchRef = useRef<HTMLInputElement>(null)

  const statsQ = useQuery({ queryKey: ["stats"], queryFn: getStats })
  const stats = statsQ.data ?? []
  const total = stats.reduce((a, s) => a + s.messages, 0)

  // "/" focuses search from anywhere outside an input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey) return
      const t = e.target as HTMLElement
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return
      e.preventDefault()
      setView("search")
      requestAnimationFrame(() => searchRef.current?.focus())
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-5 border-b bg-card px-4 py-2">
        <h1 className="flex items-center gap-1.5 text-sm font-semibold tracking-wide">
          <Landmark className="size-4 text-primary" />
          <span>
            <span className="text-primary">aqt</span>-bank
          </span>
        </h1>
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList className="h-8">
            <TabsTrigger value="search" className="text-xs">Search</TabsTrigger>
            <TabsTrigger value="browse" className="text-xs">Browse</TabsTrigger>
            <TabsTrigger value="contacts" className="text-xs">Contacts</TabsTrigger>
            <TabsTrigger value="stats" className="text-xs">Stats</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto text-xs tabular-nums text-muted-foreground/70">
          {statsQ.isError
            ? "archive unreachable"
            : total
              ? `${total.toLocaleString("en")} messages`
              : ""}
        </div>
      </header>

      {view === "stats" ? (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <StatsView
            stats={stats}
            onOpenSource={(s) => {
              setBrowseSource(s)
              setView("browse")
            }}
          />
        </main>
      ) : (
        <main className="flex min-h-0 flex-1">
          <div className="flex w-[44%] min-w-[380px] max-w-[560px] flex-col border-r">
            {view === "search" && (
              <SearchView
                stats={stats}
                selection={selection}
                onSelect={setSelection}
                searchRef={searchRef}
              />
            )}
            {view === "browse" && (
              <BrowseView
                stats={stats}
                selection={selection}
                onSelect={setSelection}
                source={browseSource}
                onSourceChange={setBrowseSource}
              />
            )}
            {view === "contacts" && (
              <ContactsView selection={selection} onSelect={setSelection} />
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <DetailPane selection={selection} />
          </div>
        </main>
      )}
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={client}>
      <Shell />
    </QueryClientProvider>
  )
}

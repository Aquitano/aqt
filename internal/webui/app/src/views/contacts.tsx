import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { getContacts } from "@/lib/api"
import { Input } from "@/components/ui/input"
import type { Selection } from "@/components/detail-pane"
import { ListSkeleton } from "@/views/search"
import { cn } from "@/lib/utils"

export function ContactsView({
  selection,
  onSelect,
}: {
  selection: Selection
  onSelect: (s: Selection) => void
}) {
  const [filter, setFilter] = useState("")
  const q = useQuery({ queryKey: ["contacts"], queryFn: getContacts })

  const contacts = (q.data ?? []).filter((c) => {
    if (!filter) return true
    const f = filter.toLowerCase()
    return (
      c.name.toLowerCase().includes(f) ||
      (c.aliases ?? []).some((a) => a.value.toLowerCase().includes(f))
    )
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pt-3 pb-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter contacts…"
          className="h-8 text-sm"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {q.isLoading ? (
          <ListSkeleton />
        ) : q.isError ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {(q.error as Error).message}
          </div>
        ) : contacts.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">No contacts yet</div>
        ) : (
          contacts.map((c) => (
            <button
              key={c.name}
              onClick={() => onSelect({ kind: "contact", name: c.name })}
              data-row
              data-selected={
                (selection?.kind === "contact" && selection.name === c.name) || undefined
              }
              className={cn(
                "flex w-full items-baseline gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left hover:bg-accent/50",
                selection?.kind === "contact" && selection.name === c.name &&
                  "border-border bg-accent",
              )}
            >
              <span className="shrink-0 text-sm font-semibold">{c.name}</span>
              <span className="truncate text-xs text-muted-foreground/70">
                {(c.aliases ?? []).map((a) => a.value).join(" · ")}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

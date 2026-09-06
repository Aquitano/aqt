import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { useState } from "react";

import type { Selection } from "@/components/detail-pane";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  createContactWithAlias,
  getContacts,
  suggestContacts,
  type ContactSuggestion,
} from "@/lib/api";
import { isMe, SourceBadge } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ListSkeleton } from "@/views/search";

// "Pocket" <team@x.com> -> Pocket; bare identities get title-cased words
function suggestedName(s: ContactSuggestion) {
  for (const sample of s.samples) {
    const display = sample
      .replace(/<[^>]*>/, "")
      .replace(/"/g, "")
      .trim();
    if (display && display !== s.identity) return display;
  }
  if (s.identity.includes("@")) return s.identity;
  return s.identity.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

// identities that are the owner or an AI counterpart make no sense as contacts
function isContactable(s: ContactSuggestion) {
  return !isMe(s.identity) && s.identity !== "assistant";
}

function SuggestionRow({ s }: { s: ContactSuggestion }) {
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: () => createContactWithAlias(suggestedName(s), s.identity),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contacts"] });
      void qc.invalidateQueries({ queryKey: ["contact-suggestions"] });
    },
  });
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm">{suggestedName(s)}</span>
          <span className="shrink-0 text-xs text-muted-foreground/60 tabular-nums">
            {s.messages.toLocaleString("en")} msgs
          </span>
        </div>
        <div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground/70">
          {s.sources.map((src) => (
            <SourceBadge key={src} source={src} />
          ))}
          <span className="truncate">{s.identity}</span>
        </div>
      </div>
      <Button
        variant="outline"
        size="xs"
        className="shrink-0"
        disabled={add.isPending}
        onClick={() => add.mutate()}
        title={`Create contact "${suggestedName(s)}" with alias ${s.identity}`}
      >
        {add.isPending ? <Spinner className="size-3" /> : <UserPlus className="size-3" />}
        Add
      </Button>
    </div>
  );
}

export function ContactsView({
  selection,
  onSelect,
}: {
  selection: Selection;
  onSelect: (s: Selection) => void;
}) {
  const [filter, setFilter] = useState("");
  const q = useQuery({ queryKey: ["contacts"], queryFn: getContacts });
  const sugg = useQuery({ queryKey: ["contact-suggestions"], queryFn: () => suggestContacts(40) });

  const f = filter.toLowerCase();
  const contacts = (q.data ?? []).filter(
    (c) =>
      !f ||
      c.name.toLowerCase().includes(f) ||
      (c.aliases ?? []).some((a) => a.value.toLowerCase().includes(f)),
  );
  const known = new Set(
    (q.data ?? []).flatMap((c) => [
      c.name.toLowerCase(),
      ...(c.aliases ?? []).map((a) => a.value.toLowerCase()),
    ]),
  );
  const suggestions = (sugg.data ?? [])
    .filter(isContactable)
    .filter((s) => !known.has(s.identity.toLowerCase()))
    .filter((s) => !f || s.identity.includes(f) || suggestedName(s).toLowerCase().includes(f));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pt-3 pb-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter contacts and suggestions…"
          className="h-8 text-sm"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {q.isLoading ? (
          <ListSkeleton />
        ) : q.isError ? (
          <div className="py-12 text-center text-sm text-muted-foreground">{q.error.message}</div>
        ) : (
          <>
            {contacts.map((c) => (
              <button
                key={c.name}
                onClick={() => onSelect({ kind: "contact", name: c.name })}
                data-row
                data-selected={
                  (selection?.kind === "contact" && selection.name === c.name) || undefined
                }
                className={cn(
                  "flex w-full items-baseline gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left hover:bg-accent/50",
                  selection?.kind === "contact" &&
                    selection.name === c.name &&
                    "border-border bg-accent",
                )}
              >
                <span className="shrink-0 text-sm font-semibold">{c.name}</span>
                <span className="truncate text-xs text-muted-foreground/70">
                  {(c.aliases ?? []).map((a) => a.value).join(" · ")}
                </span>
              </button>
            ))}
            {contacts.length === 0 && !suggestions.length && !sugg.isLoading && (
              <div className="py-12 text-center text-sm text-muted-foreground">No contacts yet</div>
            )}
            {suggestions.length > 0 && (
              <>
                <div className="mt-3 mb-1 px-2.5 text-[11px] font-medium tracking-wide text-muted-foreground/60 uppercase">
                  Suggested from the archive
                </div>
                {suggestions.map((s) => (
                  <SuggestionRow key={s.identity} s={s} />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

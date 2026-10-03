import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { useState } from "react";

import { AliasScope, refreshContacts } from "@/components/contact-editor";
import type { Selection } from "@/components/detail-pane";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  createContact,
  addContactAlias,
  getContacts,
  suggestContacts,
  type Contact,
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

function SuggestionRow({ s, contacts }: { s: ContactSuggestion; contacts: Contact[] }) {
  const qc = useQueryClient();
  const [target, setTarget] = useState("new");
  const [name, setName] = useState(suggestedName(s));
  const [source, setSource] = useState(s.sources.length === 1 ? s.sources[0] : "");
  const [created, setCreated] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: async () => {
      const contactName = target === "new" ? (created ?? name.trim()) : target.slice(2);
      if (target === "new" && !created) {
        await createContact(contactName);
        setCreated(contactName);
      }
      await addContactAlias(contactName, s.identity, source);
    },
    onSettled: () => refreshContacts(qc),
  });
  return (
    <details className="rounded-lg px-2.5 py-2">
      <summary className="cursor-pointer">
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
      </summary>
      <form
        className="mt-3 grid grid-cols-2 gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add.mutate();
        }}
      >
        <Select
          value={target}
          onValueChange={setTarget}
          disabled={add.isPending || created !== null}
        >
          <SelectTrigger className="col-span-2 w-full" aria-label={`Contact for ${s.identity}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="new">Create a new contact</SelectItem>
              {contacts.map((contact) => (
                <SelectItem key={contact.name} value={`c:${contact.name}`}>
                  {contact.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {target === "new" && (
          <Input
            className="col-span-2"
            aria-label={`Name for ${s.identity}`}
            value={name}
            required
            disabled={add.isPending || created !== null}
            onChange={(event) => setName(event.target.value)}
          />
        )}
        <AliasScope
          source={source}
          sources={s.sources}
          onChange={setSource}
          disabled={add.isPending}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={add.isPending || (target === "new" && !name.trim())}
        >
          {add.isPending ? <Spinner className="size-3" /> : <UserPlus className="size-3" />}
          {target === "new" && !created ? "Create and attach" : "Attach identity"}
        </Button>
        {add.isError && (
          <p role="alert" className="col-span-2 text-sm text-destructive">
            {created && `Contact ${created} was created. `}
            {add.error.message}
          </p>
        )}
      </form>
    </details>
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
  const [name, setName] = useState("");
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: () => createContact(name.trim()),
    onSuccess: async (contact) => {
      setName("");
      await refreshContacts(client);
      onSelect({ kind: "contact", name: contact.name });
    },
  });
  const q = useQuery({ queryKey: ["contacts"], queryFn: getContacts });
  const sugg = useQuery({ queryKey: ["contact-suggestions"], queryFn: () => suggestContacts(40) });

  const f = filter.toLowerCase();
  const contacts = (q.data ?? []).filter(
    (c) =>
      !f ||
      c.name.toLowerCase().includes(f) ||
      (c.aliases ?? []).some((a) => a.value.toLowerCase().includes(f)),
  );
  const suggestions = (sugg.data ?? [])
    .filter(isContactable)
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
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <Input
            aria-label="New contact name"
            placeholder="New contact name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            disabled={create.isPending}
          />
          <Button type="submit" variant="outline" disabled={create.isPending || !name.trim()}>
            Create
          </Button>
        </form>
        {create.isError && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {create.error.message}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {sugg.isError && (
          <p role="alert" className="p-3 text-sm text-destructive">
            {sugg.error.message}
          </p>
        )}
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
                  <SuggestionRow
                    key={JSON.stringify([s.identity, s.sources])}
                    s={s}
                    contacts={q.data ?? []}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

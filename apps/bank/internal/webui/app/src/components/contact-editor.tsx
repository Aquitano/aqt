import { Button } from "@aqt/ui/components/button";
import { Input } from "@aqt/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aqt/ui/components/select";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { addContactAlias, getContacts, getStats, removeContactAlias } from "@/lib/api";

const ALL_SOURCES = "__all__";

export function refreshContacts(client: QueryClient) {
  return Promise.all([
    client.resetQueries({ queryKey: ["detail", { kind: "contact" }] }),
    ...["contacts", "contact-suggestions", "search", "browse", "library"].map((key) =>
      client.invalidateQueries({ queryKey: [key] }),
    ),
  ]);
}

export function AliasScope({
  source,
  sources,
  onChange,
  disabled,
}: {
  source: string;
  sources: string[];
  onChange: (source: string) => void;
  disabled?: boolean;
}) {
  const items = [
    { value: ALL_SOURCES, label: "All sources" },
    ...sources.map((value) => ({ value, label: value })),
  ];
  return (
    <Select
      items={items}
      value={source || ALL_SOURCES}
      onValueChange={(value) => onChange(value === null || value === ALL_SOURCES ? "" : value)}
      disabled={disabled}
    >
      <SelectTrigger aria-label="Identity source" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function ContactEditor({ name }: { name: string }) {
  const client = useQueryClient();
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: getContacts });
  const stats = useQuery({ queryKey: ["stats"], queryFn: getStats });
  const contact = contacts.data?.find((c) => c.name === name);
  const [value, setValue] = useState("");
  const [source, setSource] = useState("");
  const add = useMutation({
    mutationFn: () => addContactAlias(name, value.trim(), source),
    onSuccess: async () => {
      setValue("");
      await refreshContacts(client);
    },
  });
  const remove = useMutation({
    mutationFn: (alias: { value: string; source?: string }) =>
      removeContactAlias(name, alias.value, alias.source),
    onSuccess: () => refreshContacts(client),
  });
  const pending = add.isPending || remove.isPending;
  return (
    <details className="shrink-0 border-b px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium">Manage identities for {name}</summary>
      <div className="max-h-80 space-y-3 overflow-y-auto pt-3">
        {contacts.isError && (
          <p role="alert" className="text-sm text-destructive">
            {contacts.error.message}
          </p>
        )}
        {contact?.aliases?.map((alias) => (
          <div key={`${alias.source}:${alias.value}`} className="flex items-center gap-3 text-sm">
            <span className="min-w-0 flex-1 break-all">
              {alias.value}
              <span className="ml-2 text-xs text-muted-foreground">
                {alias.source || "All sources"}
              </span>
            </span>
            <Button
              variant="outline"
              size="xs"
              disabled={pending}
              aria-label={`Remove identity ${alias.value}`}
              onClick={() => remove.mutate(alias)}
            >
              Remove
            </Button>
          </div>
        ))}
        {contact && !contact.aliases?.length && (
          <p className="text-sm text-muted-foreground">
            Add an identity to find this contact’s messages.
          </p>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) add.mutate();
          }}
        >
          <label className="min-w-40 flex-1 text-xs text-muted-foreground">
            Email or username
            <Input
              className="mt-1"
              required
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={pending}
            />
          </label>
          <div className="w-40">
            <AliasScope
              source={source}
              sources={stats.data?.map((s) => s.source) ?? []}
              onChange={setSource}
              disabled={pending}
            />
          </div>
          <Button type="submit" disabled={pending || !contact || !value.trim()}>
            Add identity
          </Button>
        </form>
        {(add.error || remove.error) && (
          <p role="alert" className="text-sm text-destructive">
            {(add.error || remove.error)?.message}
          </p>
        )}
      </div>
    </details>
  );
}

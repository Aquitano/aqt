import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp, Search, ShieldAlert } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { uploadFiles, type RecordedDate } from "@/lib/library-api";

export const ITEM_KINDS = [
  "movie",
  "series",
  "episode",
  "video",
  "track",
  "album",
  "podcast",
  "book",
  "article",
  "other",
];
export const STATUSES = [
  { value: "unset", label: "Not recorded" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In progress" },
  { value: "seen", label: "Seen" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "dropped", label: "Dropped" },
];
export function recordedDate(date: RecordedDate) {
  if (!date.value || date.precision === "unknown") return "Date unknown";
  if (date.precision === "day") return `${date.value} · time unknown`;
  const value = new Date(date.value);
  return Number.isNaN(value.getTime()) ? "Date unknown" : value.toLocaleString();
}
export function SourceLabel({ source, account }: { source: string; account?: string }) {
  return (
    <span className="text-xs text-muted-foreground">
      {source || "Source unknown"}
      {account ? ` · ${account}` : ""}
    </span>
  );
}
export function ErrorNotice({ error, children }: { error: Error; children?: ReactNode }) {
  return (
    <Alert variant="destructive">
      <ShieldAlert />
      <AlertTitle>Could not complete the request</AlertTitle>
      <AlertDescription>
        {error.message}
        {children}
      </AlertDescription>
    </Alert>
  );
}
export function LibraryEmpty({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Search />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
export function Choice({
  label,
  value,
  options,
  onChange,
  id,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  id?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} aria-label={label} className="w-full min-w-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
export function LibraryFilters({
  noun,
  kinds,
  onChange,
}: {
  noun: string;
  kinds: string[];
  onChange: (filters: { q: string; kind: string; source: string }) => void;
}) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState("all");
  const [source, setSource] = useState("");
  return (
    <form
      className="px-4 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        onChange({ q: text.trim(), kind: kind === "all" ? "" : kind, source: source.trim() });
      }}
    >
      <FieldGroup className="gap-3">
        <Field>
          <FieldLabel className="sr-only" htmlFor={`${noun}-query`}>
            Search {noun}
          </FieldLabel>
          <Input
            id={`${noun}-query`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={`Search ${noun}…`}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <div className="min-w-28 flex-1">
            <Choice
              label={`${noun} kind`}
              value={kind}
              options={[
                { value: "all", label: "All kinds" },
                ...kinds.map((value) => ({ value, label: value })),
              ]}
              onChange={(value) => {
                setKind(value);
                onChange({
                  q: text.trim(),
                  kind: value === "all" ? "" : value,
                  source: source.trim(),
                });
              }}
            />
          </div>
          <Input
            aria-label="Filter source"
            className="min-w-28 flex-1"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="Source"
          />
          <Button type="submit" variant="outline">
            <Search data-icon="inline-start" />
            Filter
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
export function UploadFiles({ itemId }: { itemId?: string }) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const upload = useMutation({
    mutationFn: () => uploadFiles(files, itemId),
    onSuccess: async () => {
      setFiles([]);
      if (input.current) input.current.value = "";
      await client.invalidateQueries({ queryKey: ["library"] });
      await client.invalidateQueries({ queryKey: ["find"] });
    },
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        upload.mutate();
      }}
    >
      <FieldGroup className="gap-3">
        <Field>
          <FieldLabel htmlFor={`upload-${itemId ?? "all"}`}>Add files</FieldLabel>
          <Input
            ref={input}
            id={`upload-${itemId ?? "all"}`}
            type="file"
            multiple
            onChange={(event) => {
              upload.reset();
              setFiles(Array.from(event.target.files ?? []));
            }}
          />
        </Field>
      </FieldGroup>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!files.length || upload.isPending} variant="outline">
          <FileUp data-icon="inline-start" />
          {upload.isPending
            ? "Uploading…"
            : `Upload${files.length ? ` ${files.length} files` : ""}`}
        </Button>
        {upload.isSuccess && (
          <Badge variant="secondary" role="status">
            {upload.data.length} files saved
          </Badge>
        )}
      </div>
      {upload.isError && <ErrorNotice error={upload.error} />}
    </form>
  );
}
export function safeExternalURL(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

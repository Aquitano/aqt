import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { recordedDate, SourceLabel } from "@/components/library-common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { type find } from "@/lib/library-api";
import { select, type Selection } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { ItemRow } from "@/views/library";

type Results = Awaited<ReturnType<typeof find>>;
function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (!count) return null;
  return (
    <section className="mb-4">
      <h3 className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground">
        {title}
        <Badge variant="secondary">{count} shown</Badge>
      </h3>
      {children}
    </section>
  );
}
function ResultRow({
  title,
  description,
  source,
  onClick,
  selected,
}: {
  title: string;
  description?: string;
  source?: string;
  onClick: () => void;
  selected: boolean;
}) {
  return (
    <button
      data-row
      data-selected={selected || undefined}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg p-3 text-left hover:bg-accent/50",
        selected && "bg-accent",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 text-sm font-medium break-words">{title}</span>
        {description && <p className="line-clamp-2 text-xs text-muted-foreground">{description}</p>}
        {source && <SourceLabel source={source} />}
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
export function LibrarySearchGroups({
  pages,
  selection,
}: {
  pages: Results[];
  selection: Selection;
}) {
  const items = pages.flatMap((page) => page.items);
  const activity = pages.flatMap((page) => page.activity);
  const collections = pages.flatMap((page) => page.collections);
  const files = pages.flatMap((page) => page.files);
  const attachments = pages.flatMap((page) => page.attachments);
  const notes = pages.flatMap((page) => page.pages);
  const coverage = [...new Set(pages.flatMap((page) => page.coverage))];
  return (
    <>
      {coverage.length > 0 && (
        <Alert className="my-2">
          <AlertTitle>Search coverage</AlertTitle>
          <AlertDescription>
            {coverage.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </AlertDescription>
        </Alert>
      )}
      <Group title="Library" count={items.length}>
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            selected={selection?.kind === "item" && selection.id === item.id}
          />
        ))}
      </Group>
      <Group title="Activity" count={activity.length}>
        {activity.map((event) => (
          <ResultRow
            key={event.id}
            selected={selection?.kind === "item" && selection.id === event.item_id}
            title={event.title}
            description={`${event.kind} · ${recordedDate(event.occurred)}`}
            source={event.source}
            onClick={() => select({ kind: "item", id: event.item_id })}
          />
        ))}
      </Group>
      <Group title="Collections" count={collections.length}>
        {collections.map((collection) => (
          <ResultRow
            key={collection.id}
            selected={selection?.kind === "collection" && selection.id === collection.id}
            title={collection.title}
            description={`${collection.kind} · ${collection.snapshot?.entry_count ?? 0} entries · ${collection.snapshot?.completeness ?? "unknown"} coverage`}
            source={collection.source}
            onClick={() => select({ kind: "collection", id: collection.id })}
          />
        ))}
      </Group>
      <Group title="Library files" count={files.length}>
        {files.map((file) => (
          <ResultRow
            key={file.id}
            selected={selection?.kind === "file" && selection.file.sha256 === file.sha256}
            title={file.filename}
            description={file.mime_type}
            source={file.source}
            onClick={() => select({ kind: "file", file })}
          />
        ))}
      </Group>
      <Group title="Message attachments" count={attachments.length}>
        {attachments.map((file) => (
          <ResultRow
            key={file.sha256}
            selected={selection?.kind === "file" && selection.file.sha256 === file.sha256}
            title={file.filename}
            description={file.snippet || file.mime_type}
            onClick={() => select({ kind: "file", file })}
          />
        ))}
      </Group>
      <Group title="Knowledge" count={notes.length}>
        {notes.map((page) => (
          <ResultRow
            key={page.id}
            selected={selection?.kind === "page" && selection.id === page.id}
            title={page.title}
            description={`${page.path} · revision ${page.revision || "unknown"}`}
            source={page.source}
            onClick={() => select({ kind: "page", id: page.id })}
          />
        ))}
      </Group>
    </>
  );
}

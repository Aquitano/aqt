import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getLibrary } from "@/lib/api";
import { Highlight } from "@/lib/format";
import {
  navigate,
  readSelection,
  useLocation,
  writeSelection,
  type Selection,
} from "@/lib/navigation";

const fields = [
  ["q", "fileName", "Filename", "text"],
  ["text", "fileText", "Contents contain", "text"],
  ["type", "fileType", "File type (pdf, image…)", "text"],
  ["person", "filePerson", "Contact name", "text"],
  ["since", "fileSince", "From date", "date"],
  ["until", "fileUntil", "Before date", "date"],
] as const;
type Filters = Parameters<typeof getLibrary>[0];

export function AttachmentsView({ onSelect }: { onSelect: (s: Selection) => void }) {
  const location = useLocation();
  const url = new URLSearchParams(location);
  const filters: Filters = {
    q: url.get("fileName") ?? "",
    text: url.get("fileText") ?? "",
    type: url.get("fileType") ?? "",
    person: url.get("filePerson") ?? "",
    since: url.get("fileSince") ?? "",
    until: url.get("fileUntil") ?? "",
  };
  return (
    <AttachmentList
      key={JSON.stringify(filters)}
      filters={filters}
      selection={readSelection(url)}
      onSelect={onSelect}
    />
  );
}

function AttachmentList({
  filters,
  selection,
  onSelect,
}: {
  filters: Filters;
  selection: Selection;
  onSelect: (s: Selection) => void;
}) {
  const [draft, setDraft] = useState(filters);
  const q = useInfiniteQuery({
    queryKey: ["library", filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getLibrary(filters, pageParam),
    getNextPageParam: (last, pages) => (last.length === 50 ? pages.length * 50 : undefined),
  });
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <h2 className="mb-3 font-semibold">Attachment library</h2>
      <form
        className="grid grid-cols-2 gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          navigate((params) => {
            for (const [key, urlKey] of fields) {
              if (draft[key]) params.set(urlKey, draft[key]);
              else params.delete(urlKey);
            }
            writeSelection(params, null);
          });
        }}
      >
        {fields.map(([key, , label, type]) => (
          <label key={key} className="text-xs text-muted-foreground">
            {label}
            <Input
              className="mt-1"
              type={type}
              value={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          </label>
        ))}
        <Button type="submit" className="col-span-2">
          Find files
        </Button>
      </form>
      {q.isPending && <p className="mt-4">Loading files…</p>}
      {q.isError && (
        <p className="mt-4" role="alert">
          {q.error.message}
        </p>
      )}
      {q.data?.pages[0].length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">No files match these filters.</p>
      )}
      <div className="mt-4 space-y-2">
        {q.data?.pages.flat().map((file) => (
          <button
            type="button"
            aria-pressed={selection?.kind === "file" && selection.file.sha256 === file.sha256}
            key={file.sha256}
            className="block w-full rounded border p-3 text-left text-sm hover:bg-accent aria-pressed:bg-accent"
            onClick={() => onSelect({ kind: "file", file })}
          >
            <span className="block font-medium break-all">{file.filename}</span>
            <span className="text-xs text-muted-foreground">
              {file.mime_type || "Unknown type"} · {Math.ceil(file.size_bytes / 1024)} KB ·{" "}
              {file.messages} messages
            </span>
            {file.snippet && (
              <span className="mt-2 line-clamp-3 block text-xs text-muted-foreground">
                <Highlight text={file.snippet} query={filters.text} />
              </span>
            )}
          </button>
        ))}
      </div>
      {q.hasNextPage && (
        <Button
          className="mt-3"
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          More files
        </Button>
      )}
    </div>
  );
}

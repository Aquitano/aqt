import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { Selection } from "@/components/detail-pane";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getFileMessages, getFileText, getLibrary, type LibraryFile } from "@/lib/api";

function FileDetail({ file, onSelect }: { file: LibraryFile; onSelect: (s: Selection) => void }) {
  const text = useQuery({
    queryKey: ["file-text", file.sha256],
    queryFn: () => getFileText(file.sha256),
    retry: false,
  });
  const messages = useInfiniteQuery({
    queryKey: ["file-messages", file.sha256],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getFileMessages(file.sha256, pageParam),
    getNextPageParam: (last, pages) => (last.length === 50 ? pages.length * 50 : undefined),
  });
  return (
    <section className="mt-4 border-t pt-4">
      <h3 className="font-medium break-all">{file.filename}</h3>
      <a className="text-sm underline" href={`/v1/blobs/${file.sha256}`} download={file.filename}>
        Download original
      </a>
      <h4 className="mt-4 text-sm font-medium">Document preview</h4>
      {file.mime_type === "application/pdf" && (
        <object
          aria-label={`Preview of ${file.filename}`}
          type="application/pdf"
          data={`/v1/attachments/${file.sha256}/preview`}
          className="mt-2 h-96 w-full rounded border"
        >
          <p className="text-sm text-muted-foreground">
            PDF preview is unavailable in this browser. Download the original or read the extracted
            text below.
          </p>
        </object>
      )}
      {["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mime_type) && (
        <img
          alt={file.filename}
          src={`/v1/attachments/${file.sha256}/preview`}
          className="mt-2 max-h-96 max-w-full object-contain"
        />
      )}

      {text.isPending ? (
        <p className="text-sm">Loading preview…</p>
      ) : text.data?.text ? (
        <pre className="mt-2 max-h-80 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
          {text.data.text}
        </pre>
      ) : (
        <p className="text-sm text-muted-foreground">
          No extracted text available. Download the original to view it.
        </p>
      )}
      <h4 className="mt-4 text-sm font-medium">{file.messages} messages containing this file</h4>
      {messages.isPending && <p>Loading messages…</p>}
      {messages.isError && <p role="alert">{messages.error.message}</p>}
      {messages.data?.pages.flat().map((m) => (
        <button
          type="button"
          key={m.id}
          className="mt-2 block w-full rounded border p-3 text-left text-sm hover:bg-accent"
          onClick={() =>
            onSelect(
              m.thread_id
                ? {
                    kind: "thread",
                    source: m.source,
                    threadId: m.thread_id,
                    flashId: m.id,
                    title: m.subject,
                  }
                : { kind: "message", id: m.id },
            )
          }
        >
          <span className="block font-medium">
            {m.sender} · {new Date(m.sent_at).toLocaleDateString()}
          </span>
          <span className="line-clamp-2 text-muted-foreground">{m.subject || m.body}</span>
        </button>
      ))}
      {messages.hasNextPage && (
        <Button
          className="mt-3"
          disabled={messages.isFetchingNextPage}
          onClick={() => void messages.fetchNextPage()}
        >
          More messages
        </Button>
      )}
    </section>
  );
}

export function AttachmentsView({ onSelect }: { onSelect: (s: Selection) => void }) {
  const [draft, setDraft] = useState({ q: "", type: "", person: "", since: "", until: "" });
  const [filters, setFilters] = useState(draft);
  const [selected, setSelected] = useState<LibraryFile | null>(null);
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
          setFilters(draft);
          setSelected(null);
        }}
      >
        {(
          [
            ["q", "Filename", "text"],
            ["type", "File type (pdf, image…)", "text"],
            ["person", "Contact name", "text"],
            ["since", "From date", "date"],
            ["until", "Before date", "date"],
          ] as const
        ).map(([key, label, type]) => (
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
        <Button type="submit" className="self-end">
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
            aria-pressed={selected?.sha256 === file.sha256}
            key={file.sha256}
            className="block w-full rounded border p-3 text-left text-sm hover:bg-accent aria-pressed:bg-accent"
            onClick={() => setSelected(file)}
          >
            <span className="block font-medium break-all">{file.filename}</span>
            <span className="text-xs text-muted-foreground">
              {file.mime_type || "Unknown type"} · {Math.ceil(file.size_bytes / 1024)} KB ·{" "}
              {file.messages} messages
            </span>
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
      {selected && <FileDetail key={selected.sha256} file={selected} onSelect={onSelect} />}
    </div>
  );
}

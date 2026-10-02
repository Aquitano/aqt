import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import { getFileMessages, getFileText, RequestError, type Attachment } from "@/lib/api";
import { Highlight } from "@/lib/format";
import { select, useLocation } from "@/lib/navigation";
import { selectMessage } from "@/views/search";

export function FilePreview({ file }: { file: Attachment }) {
  const location = useLocation();
  const params = new URLSearchParams(location);
  const query = params.get("view") === "attachments" ? params.get("fileText") : params.get("q");
  const phrase = params.get("view") === "attachments";
  const preview = useRef<HTMLPreElement>(null);
  const text = useQuery({
    queryKey: ["file-text", file.sha256],
    queryFn: () => getFileText(file.sha256),
    retry: false,
  });
  const content = text.data?.text ?? "";
  const matchIndex = query ? content.toLowerCase().indexOf(query.toLowerCase()) : -1;
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label={`Preview of ${file.filename}`}>
      <h3 className="font-medium break-all">{file.filename}</h3>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={`/v1/blobs/${file.sha256}`} download={file.filename}>
            Download original
          </a>
        </Button>
        {query && content && (!phrase || matchIndex >= 0) && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              preview.current?.querySelector("mark")?.scrollIntoView({ block: "center" })
            }
          >
            Jump to match
          </Button>
        )}
      </div>
      {file.mime_type === "application/pdf" && (
        <object
          aria-label={file.filename}
          type="application/pdf"
          data={`/v1/attachments/${file.sha256}/preview`}
          className="h-96 w-full rounded border"
        >
          <p>PDF preview is unavailable. Download the original or read the extracted text below.</p>
        </object>
      )}
      {["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mime_type ?? "") && (
        <img
          alt={file.filename}
          src={`/v1/attachments/${file.sha256}/preview`}
          className="max-h-96 max-w-full object-contain"
        />
      )}
      {text.isPending ? (
        <p role="status">Loading extracted text…</p>
      ) : text.isError && !(text.error instanceof RequestError && text.error.status === 404) ? (
        <p role="alert" className="text-destructive">
          {text.error.message}
        </p>
      ) : text.data?.text ? (
        <pre
          ref={preview}
          className="max-h-96 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap"
        >
          {phrase && query && matchIndex >= 0 ? (
            <>
              {content.slice(0, matchIndex)}
              <mark className="bg-transparent font-semibold text-amber-500 dark:text-amber-300">
                {content.slice(matchIndex, matchIndex + query.length)}
              </mark>
              {content.slice(matchIndex + query.length)}
            </>
          ) : (
            <Highlight text={content} query={phrase ? undefined : (query ?? undefined)} />
          )}
        </pre>
      ) : (
        <p className="text-sm text-muted-foreground">
          {text.data?.status === "needs_ocr"
            ? "This file needs OCR before its text can be searched."
            : "No extracted text is available. Download the original to read it."}
        </p>
      )}
    </section>
  );
}

export function FileDetail({ file }: { file: Attachment }) {
  const messages = useInfiniteQuery({
    queryKey: ["file-messages", file.sha256],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getFileMessages(file.sha256, pageParam),
    getNextPageParam: (last, pages) => (last.length === 50 ? pages.length * 50 : undefined),
  });
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <FilePreview file={file} />
      <h3 className="font-medium">Messages containing this file</h3>
      {messages.isPending && <p role="status">Loading messages…</p>}
      {messages.isError && <p role="alert">{messages.error.message}</p>}
      {messages.data?.pages.flat().map((message) => (
        <Button
          key={message.id}
          variant="outline"
          className="h-auto justify-start whitespace-normal"
          onClick={() => select(selectMessage(message))}
        >
          <span className="flex min-w-0 flex-col gap-1 text-left">
            <span>
              {message.sender} · {new Date(message.sent_at).toLocaleDateString()}
            </span>
            <span className="line-clamp-2">{message.subject || message.body}</span>
          </span>
        </Button>
      ))}
      {messages.hasNextPage && (
        <Button
          disabled={messages.isFetchingNextPage}
          onClick={() => void messages.fetchNextPage()}
        >
          More messages
        </Button>
      )}
    </div>
  );
}

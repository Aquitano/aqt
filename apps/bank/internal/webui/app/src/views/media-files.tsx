import { useInfiniteQuery } from "@tanstack/react-query";
import { File } from "lucide-react";

import {
  ErrorNotice,
  LibraryEmpty,
  LibraryFilters,
  SourceLabel,
  UploadFiles,
} from "@/components/library-common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getMediaFiles, LIBRARY_PAGE } from "@/lib/library-api";
import { select, useLibraryFilters, type Selection } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { ListSkeleton } from "@/views/search";

export function MediaFilesView({ selection }: { selection: Selection }) {
  const [filters, setFilters] = useLibraryFilters("media-files");
  const query = useInfiniteQuery({
    queryKey: ["library", "files", filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getMediaFiles(filters, pageParam),
    getNextPageParam: (last, pages) =>
      last.length === LIBRARY_PAGE ? pages.length * LIBRARY_PAGE : undefined,
  });
  const files = query.data?.pages.flat() ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="p-4">
        <h2 className="text-lg font-semibold">Library files</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Uploaded originals and media linked to your library.
        </p>
      </div>
      <LibraryFilters
        key={JSON.stringify(filters)}
        filters={filters}
        noun="files"
        kinds={[]}
        onChange={setFilters}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <div className="mb-5 rounded-xl border p-3">
          <UploadFiles />
        </div>
        {query.isPending ? (
          <ListSkeleton />
        ) : query.isError ? (
          <ErrorNotice error={query.error} />
        ) : !files.length ? (
          <LibraryEmpty
            title="No matching files"
            description="Upload one or more files. Files from messages are available in the Attachments tab."
          />
        ) : (
          files.map((file) => (
            <button
              key={file.id}
              data-row
              data-selected={
                (selection?.kind === "file" && selection.file.sha256 === file.sha256) || undefined
              }
              onClick={() => select({ kind: "file", file })}
              className={cn(
                "flex w-full items-start gap-3 rounded-lg p-3 text-left hover:bg-accent/50",
                selection?.kind === "file" && selection.file.sha256 === file.sha256 && "bg-accent",
              )}
            >
              <File className="mt-1 size-5 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="line-clamp-2 text-sm font-medium break-all">{file.filename}</span>
                <SourceLabel source={file.source} account={file.account} />
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{file.mime_type || "Unknown type"}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {(file.size_bytes / 1024).toLocaleString(undefined, {
                      maximumFractionDigits: 1,
                    })}{" "}
                    KB
                  </span>
                </div>
              </div>
            </button>
          ))
        )}
        {query.hasNextPage && (
          <Button
            className="my-3"
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            Load more files
          </Button>
        )}
      </div>
    </div>
  );
}

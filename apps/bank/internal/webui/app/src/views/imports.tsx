import { useInfiniteQuery } from "@tanstack/react-query";

import { LibraryImportForm } from "@/components/library-import";
import { Button } from "@/components/ui/button";
import { getImportReports } from "@/lib/api";

export function ImportsView() {
  const q = useInfiniteQuery({
    queryKey: ["import-reports"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getImportReports(pageParam),
    getNextPageParam: (last) => (last.length === 50 ? last[last.length - 1].id : undefined),
    refetchInterval: 10000,
  });
  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-6">
      <LibraryImportForm />
      <h2 className="text-lg font-semibold">Import reports</h2>
      <p className="mb-5 text-sm text-muted-foreground">
        Each attempt stays here, including gaps and failures. Reports start with imports made after
        this update.
      </p>
      {q.isPending && <p>Loading reports…</p>}
      {q.isError && <p role="alert">{q.error.message}</p>}
      {q.data?.pages[0].length === 0 && <p>No imports recorded yet.</p>}
      <div className="space-y-4">
        {q.data?.pages.flat().map((report) => {
          const r = report.result;
          const issues = [
            ...new Set([
              ...(r.issues ?? []),
              ...(r.warnings ?? []),
              ...(r.failed_sessions ?? []),
              ...(r.failed_channels ?? []),
            ]),
          ];
          const counters = [
            [
              ["netflix", "youtube-media", "library", "markdown"].includes(report.kind)
                ? "Records imported"
                : "Messages imported",
              r.inserted,
            ],
            ["Already present", r.duplicates],
            ["New files preserved", r.files_preserved],
            ["Missing assets", r.missing_media],
            ["Unsupported content", r.unsupported_content],
            ["Rejected", r.rejected],
            ["Skipped", r.skipped],
            ["Damaged messages", r.damaged],
            ["Empty conversations", r.empty_conversations],
          ] as const;
          return (
            <article key={report.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-baseline gap-3">
                <h3 className="font-medium">{report.kind}</h3>
                <span
                  className={
                    report.status === "complete" ? "text-muted-foreground" : "text-amber-400"
                  }
                >
                  {report.status === "running"
                    ? "Unfinished or running"
                    : report.status === "gaps"
                      ? "Completed with notes"
                      : report.status}
                </span>
                <time className="ml-auto text-xs text-muted-foreground">
                  {new Date(report.started_at).toLocaleString()}
                </time>
              </div>
              <p className="mt-1 text-xs break-all text-muted-foreground">{report.input}</p>
              <dl className="my-4 flex flex-wrap gap-x-8 gap-y-3">
                {counters.map(([label, count]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd>{count ?? "Not measured"}</dd>
                  </div>
                ))}
              </dl>
              {report.error && <p className="text-sm break-words text-red-400">{report.error}</p>}
              {issues.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-sm">
                    {issues.length} saved details
                  </summary>
                  <ul className="mt-2 list-inside list-disc text-sm">
                    {issues.map((issue) => (
                      <li key={issue} className="break-all">
                        {issue}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </article>
          );
        })}
      </div>
      {q.hasNextPage && (
        <Button
          className="mt-4"
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          Older reports
        </Button>
      )}
    </main>
  );
}

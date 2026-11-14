import { Button } from "@aqt/ui/components/button";
import { useInfiniteQuery } from "@tanstack/react-query";

import { LibraryImportForm } from "@/components/library-import";
import { getRawInputs } from "@/lib/api";

const issueLabels = new Map([
  ["missing_media", "Missing media"],
  ["rejected", "Rejected"],
  ["skipped", "Skipped"],
  ["unsupported", "Unsupported content"],
  ["damaged", "Damaged"],
  ["incomplete", "Incomplete"],
  ["dropped", "Left out on purpose"],
]);
const issueLabel = (kind: string) => issueLabels.get(kind) ?? kind;

export function ImportsView() {
  const q = useInfiniteQuery({
    queryKey: ["raw-inputs"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getRawInputs(pageParam),
    getNextPageParam: (last) => (last.length === 50 ? last.at(-1)?.id : undefined),
    refetchInterval: 10000,
  });
  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-6">
      <LibraryImportForm />
      <h2 className="text-lg font-semibold">Imports</h2>
      <p className="mb-5 text-sm text-muted-foreground">
        Every input is stored before it is read. Each one shows the outcome of its latest import,
        and an input that failed can be replayed with bank reimport.
      </p>
      {q.isPending && <p>Loading imports…</p>}
      {q.isError && <p role="alert">{q.error.message}</p>}
      {q.data?.pages[0]?.length === 0 && <p>No imports recorded yet.</p>}
      <div className="space-y-4">
        {q.data?.pages.flat().map((input) => {
          const r = input.report;
          const library = r.library;
          const counters = [
            ["Messages imported", r.inserted],
            ["Already present", r.duplicates],
            ["Retired", r.retired],
            ["Attachments stored", r.attachments],
            [
              "Library records imported",
              library.items +
                library.activity +
                library.collections +
                library.files +
                library.pages,
            ],
            ["Library records present", library.duplicates],
            ...Object.entries(r.issues ?? {}).map(([kind, n]) => [issueLabel(kind), n] as const),
          ] as const;
          const details = [
            ...new Set(
              (r.details ?? []).map((issue) => `${issueLabel(issue.kind)}: ${issue.detail}`),
            ),
          ];
          return (
            <article key={input.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-baseline gap-3">
                <h3 className="font-medium">{input.kind}</h3>
                <span
                  className={
                    input.status === "complete" ? "text-muted-foreground" : "text-amber-400"
                  }
                >
                  {input.status === "running"
                    ? "Unfinished or running"
                    : input.status === "gaps"
                      ? "Completed with notes"
                      : input.status}
                </span>
                <time className="ml-auto text-xs text-muted-foreground">
                  {new Date(input.received_at).toLocaleString()}
                </time>
              </div>
              <p className="mt-1 text-xs break-all text-muted-foreground">
                #{input.id} {input.name}
              </p>
              <dl className="my-4 flex flex-wrap gap-x-8 gap-y-3">
                {counters
                  .filter(([, count]) => count > 0)
                  .map(([label, count]) => (
                    <div key={label}>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd>{count}</dd>
                    </div>
                  ))}
              </dl>
              {input.error && <p className="text-sm break-words text-red-400">{input.error}</p>}
              {details.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-sm">
                    {details.length} saved details
                  </summary>
                  <ul className="mt-2 list-inside list-disc text-sm">
                    {details.map((detail) => (
                      <li key={detail} className="break-all">
                        {detail}
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
          Older imports
        </Button>
      )}
    </main>
  );
}

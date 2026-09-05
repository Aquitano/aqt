import type { SourceStat } from "@/lib/api";
import { fmtDay, SourceBadge } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";

export function StatsView({
  stats,
  onOpenSource,
}: {
  stats: SourceStat[];
  onOpenSource: (source: string) => void;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 overflow-y-auto p-5">
      {stats.map((s) => (
        <Card
          key={s.source}
          className="cursor-pointer gap-0 py-4 transition-colors hover:border-primary/50"
          onClick={() => onOpenSource(s.source)}
        >
          <CardContent className="px-4">
            <SourceBadge source={s.source} />
            <div className="mt-1.5 text-2xl font-bold tabular-nums">
              {s.messages.toLocaleString("en")}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {fmtDay(s.earliest)} → {fmtDay(s.latest)}
            </div>
            <div className="text-xs text-muted-foreground/70">ingested {fmtDay(s.last_ingest)}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

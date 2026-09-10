import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "server/api/routers/index";

type VisitStats = inferRouterOutputs<AppRouter>["exhibitions"]["stats"];

function StatTile({ label, value }: { label: string; value: number }) {
	return (
		<div className="flex flex-col gap-1 rounded-2xl bg-card px-5 py-4">
			<span className="font-semibold text-2xl tabular-nums tracking-[-0.02em]">
				{value.toLocaleString()}
			</span>
			<span className="text-muted-foreground text-sm">{label}</span>
		</div>
	);
}

/** Compact owner-only visit summary for a studio page. Anonymous aggregates
 * only — see the `museum_stat` table. Shows nothing actionable until the
 * gallery is published (no counters accrue before then). */
export function VisitStatsStrip({
	stats,
	isPublished,
}: {
	stats: VisitStats | undefined;
	isPublished: boolean;
}) {
	if (!isPublished) {
		return (
			<section className="flex flex-col gap-1">
				<h2 className="font-semibold text-lg tracking-[-0.02em]">
					Visitor stats
				</h2>
				<p className="text-muted-foreground text-sm">
					Publish this gallery to start collecting anonymous visit counts.
				</p>
			</section>
		);
	}

	if (!stats) return null;

	const top = stats.topArtworks;
	return (
		<section className="flex flex-col gap-4">
			<h2 className="font-semibold text-lg tracking-[-0.02em]">
				Visitor stats
			</h2>
			<div className="grid grid-cols-3 gap-4">
				<StatTile label="Page views" value={stats.pageViews} />
				<StatTile label="Walkthroughs" value={stats.sessionsEntered} />
				<StatTile label="Tours finished" value={stats.toursCompleted} />
			</div>
			<div className="flex flex-col gap-2 rounded-2xl bg-card p-5">
				<p className="font-medium text-muted-foreground text-xs">
					Most inspected
				</p>
				{top.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No artwork inspects recorded yet.
					</p>
				) : (
					<ol className="-mx-3 flex flex-col">
						{top.map((a, i) => (
							<li
								key={a.id}
								className="flex items-baseline justify-between gap-3 rounded-xl px-3 py-2 text-sm transition-colors hover:bg-secondary/60"
							>
								<span className="min-w-0 truncate">
									<span className="text-muted-foreground tabular-nums">
										{i + 1}.
									</span>{" "}
									{a.title}
									{a.artistName ? (
										<span className="text-muted-foreground">
											{" "}
											· {a.artistName}
										</span>
									) : null}
								</span>
								<span className="shrink-0 text-muted-foreground tabular-nums">
									{a.count.toLocaleString()}
								</span>
							</li>
						))}
					</ol>
				)}
			</div>
		</section>
	);
}

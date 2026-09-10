import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { ExhibitWall } from "@/components/gallery/exhibit-wall";
import { WallEmptyState } from "@/components/gallery/masonry-wall";
import { useTRPC } from "@/utils/trpc";

type ExhibitSearch = { artwork?: string };

export const Route = createFileRoute("/exhibit/$slug")({
	component: ExhibitPage,
	validateSearch: (search: Record<string, unknown>): ExhibitSearch => {
		return typeof search.artwork === "string"
			? { artwork: search.artwork }
			: {};
	},
	notFoundComponent: () => (
		<CosmosShell active="explore">
			<WallEmptyState title="No such exhibition.">
				<p>
					<Link className="underline underline-offset-4" to="/museum">
						Browse the museum
					</Link>
				</p>
			</WallEmptyState>
		</CosmosShell>
	),
});

function ExhibitPage() {
	const { slug } = Route.useParams();
	const { artwork: selectedArtworkId } = Route.useSearch();
	const trpc = useTRPC();
	const query = useQuery({
		...trpc.exhibitions.bySlug.queryOptions({ slug }),
		staleTime: Number.POSITIVE_INFINITY,
	});

	if (query.isPending) {
		return (
			<CosmosShell active="explore">
				<WallEmptyState title="Opening exhibition" />
			</CosmosShell>
		);
	}
	if (query.isError || !query.data) {
		return (
			<CosmosShell active="explore">
				<WallEmptyState title="No such exhibition.">
					<p>It may be unpublished, or the link is wrong.</p>
				</WallEmptyState>
			</CosmosShell>
		);
	}

	return (
		<CosmosShell active="explore">
			<ExhibitWall
				exhibition={query.data}
				selectedArtworkId={selectedArtworkId}
			/>
		</CosmosShell>
	);
}

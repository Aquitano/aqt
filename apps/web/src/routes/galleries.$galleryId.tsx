import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { MasonryWall } from "@/components/gallery/masonry-wall";
import type { ArtworkCard } from "@/components/gallery/types";
import { getUser } from "@/functions/get-user";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/galleries/$galleryId")({
	component: RouteComponent,
	beforeLoad: async () => {
		const session = await getUser();
		return { session };
	},
	loader: async ({ context }) => {
		if (!context.session) {
			throw redirect({ to: "/login" });
		}
	},
});

function RouteComponent() {
	const { galleryId } = Route.useParams();
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const gallery = useQuery(trpc.galleries.get.queryOptions({ id: galleryId }));
	const [search, setSearch] = useState("");
	const artworks = useQuery(
		trpc.artworks.list.queryOptions({
			galleryId,
			query: search,
			sort: "newest",
		}),
	);
	const allArtworks = useQuery(
		trpc.artworks.list.queryOptions({ sort: "newest" }),
	);
	const addArtwork = useMutation(trpc.galleries.addArtwork.mutationOptions());
	const galleryArtworkIds = new Set(
		(artworks.data ?? []).map((artwork) => artwork.id),
	);

	return (
		<CosmosShell active="galleries" search={search} onSearch={setSearch}>
			<section>
				<div className="gallery-page-heading gallery-detail-heading">
					<div>
						<p className="gallery-eyebrow">Gallery page</p>
						<h1>{gallery.data?.gallery.title ?? "Gallery"}</h1>
						{gallery.data?.gallery.description ? (
							<p>{gallery.data.gallery.description}</p>
						) : null}
					</div>
				</div>
				<MasonryWall artworks={(artworks.data ?? []) as ArtworkCard[]} />
				<section className="gallery-add-strip">
					{(allArtworks.data ?? [])
						.filter((artwork) => !galleryArtworkIds.has(artwork.id))
						.slice(0, 8)
						.map((artwork) => (
							<button
								key={artwork.id}
								className="gallery-add-button"
								type="button"
								onClick={async () => {
									await addArtwork.mutateAsync({
										galleryId,
										artworkId: artwork.id,
									});
									await queryClient.invalidateQueries();
								}}
							>
								<Plus size={14} />
								{artwork.title}
							</button>
						))}
				</section>
			</section>
		</CosmosShell>
	);
}

import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { getUser } from "@/functions/get-user";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/reviews")({
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
	const trpc = useTRPC();
	const [search, setSearch] = useState("");
	const artworks = useQuery(
		trpc.artworks.list.queryOptions({ query: search, sort: "rating" }),
	);
	const reviewed = (artworks.data ?? []).filter((artwork) => artwork.rating);

	return (
		<CosmosShell active="reviews" search={search} onSearch={setSearch}>
			<section className="reviews-page">
				<div className="gallery-page-heading">
					<div>
						<p className="gallery-eyebrow">Seen and scored</p>
						<h1>Reviews</h1>
					</div>
				</div>
				<div className="review-list">
					{reviewed.map((artwork) => (
						<Link
							key={artwork.id}
							className="review-row"
							to="/artworks/$artworkId"
							params={{ artworkId: artwork.id }}
						>
							<span>{artwork.title}</span>
							<strong>{artwork.rating}/5</strong>
							<small>{artwork.artist || artwork.artworkType}</small>
						</Link>
					))}
					{reviewed.length === 0 ? (
						<div className="gallery-empty-state">
							<h1>No reviews yet.</h1>
							<p>
								Open an artwork and add a rating or review to build this page.
							</p>
						</div>
					) : null}
				</div>
			</section>
		</CosmosShell>
	);
}

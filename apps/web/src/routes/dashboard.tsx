import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { MasonryWall } from "@/components/gallery/masonry-wall";
import type { ArtworkCard } from "@/components/gallery/types";
import { getUser } from "@/functions/get-user";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/dashboard")({
	component: RouteComponent,
	beforeLoad: async () => {
		const session = await getUser();
		return { session };
	},
	loader: async ({ context }) => {
		if (!context.session) {
			throw redirect({
				to: "/login",
			});
		}
	},
});

function RouteComponent() {
	const trpc = useTRPC();
	const [search, setSearch] = useState("");
	const artworks = useQuery(
		trpc.artworks.list.queryOptions({ query: search, sort: "newest" }),
	);

	return (
		<CosmosShell active="archive" search={search} onSearch={setSearch}>
			<MasonryWall artworks={(artworks.data ?? []) as ArtworkCard[]} />
		</CosmosShell>
	);
}

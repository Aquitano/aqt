import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { kindLabel, type LobbyExhibition } from "@/components/museum/types";
import { useTRPC } from "@/utils/trpc";

import "@/components/museum/museum.css";

export const Route = createFileRoute("/museum/")({
	component: LobbyPage,
	head: () => {
		const title = "The Museum — AQT Gallery";
		const description =
			"Walk through published exhibitions in an interactive 3D gallery.";
		return {
			meta: [
				{ title },
				{ name: "description", content: description },
				{ property: "og:type", content: "website" },
				{ property: "og:title", content: title },
				{ property: "og:description", content: description },
				{ name: "twitter:card", content: "summary_large_image" },
				{ name: "twitter:title", content: title },
				{ name: "twitter:description", content: description },
			],
		};
	},
});

function ExhibitionCard({
	exhibition,
	index,
}: {
	exhibition: LobbyExhibition;
	index: number;
}) {
	return (
		<Link
			to="/museum/$slug"
			params={{ slug: exhibition.slug }}
			className="group relative overflow-hidden rounded-2xl border border-white/8 bg-[#12100d]"
		>
			<div className="relative h-[230px] overflow-hidden">
				{exhibition.coverImageUrl ? (
					<img
						src={exhibition.coverImageUrl}
						alt=""
						loading={index < 3 ? "eager" : "lazy"}
						className="h-full w-full object-cover transition-transform duration-[1.4s] ease-out group-hover:scale-[1.07]"
					/>
				) : (
					<div className="h-full w-full bg-[#1a1713]" />
				)}
				<div className="absolute inset-0 bg-gradient-to-t from-[#12100d] to-transparent" />
				<span className="absolute top-4 left-4 rounded-full border border-white/15 bg-black/45 px-3 py-1 text-[10px] text-white/75 uppercase tracking-[0.22em] backdrop-blur">
					{kindLabel(exhibition.kind)}
				</span>
			</div>
			<div className="px-6 pt-2 pb-7">
				<h3 className="font-museum text-3xl text-[#efe8d6] leading-tight">
					{exhibition.name}
				</h3>
				<p className="mt-2 line-clamp-2 text-[13px] text-white/50 leading-relaxed">
					{exhibition.tagline ?? exhibition.description}
				</p>
				<p className="mt-4 text-[#b7a989] text-[11px] uppercase tracking-[0.24em]">
					{exhibition.roomCount > 1 ? `${exhibition.roomCount} rooms · ` : ""}
					{exhibition.artworkCount} artworks · walk through →
				</p>
			</div>
		</Link>
	);
}

function LobbySkeleton() {
	return (
		<div
			aria-busy="true"
			className="grid gap-5 px-8 pb-20 md:grid-cols-2 md:px-20 xl:grid-cols-3"
		>
			{[0, 1, 2].map((i) => (
				<div key={i} className="museum-skeleton h-[330px] rounded-2xl" />
			))}
		</div>
	);
}

function LobbyPage() {
	const trpc = useTRPC();
	const lobby = useQuery(trpc.exhibitions.lobby.queryOptions());

	return (
		<main className="min-h-screen bg-[#0b0a09] text-white">
			<header className="flex items-center justify-between px-8 pt-8 pb-6 md:px-20">
				<div>
					<p className="text-[#b7a989] text-[10px] uppercase tracking-[0.4em]">
						AQT Gallery presents
					</p>
					<h1 className="mt-1 font-museum text-3xl text-[#f0e9d8]">
						The Museum
					</h1>
				</div>
				<div className="flex items-center gap-6">
					<Link
						to="/explore"
						search={{ view: "spaces" }}
						className="text-[#c9b687] text-[11px] uppercase tracking-[0.24em] transition-colors hover:text-[#e9dcb4]"
					>
						Curate your own
					</Link>
					<Link
						to="/"
						className="text-[11px] text-white/40 uppercase tracking-[0.24em] transition-colors hover:text-white/80"
					>
						Exit to archive
					</Link>
				</div>
			</header>

			{lobby.isPending ? <LobbySkeleton /> : null}

			{lobby.isError ? (
				<div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
					<p className="font-museum text-4xl text-[#e8e2d5]">
						The doors are stuck
					</p>
					<p className="mt-4 max-w-md text-sm text-white/50 leading-relaxed">
						We couldn't reach the museum's collection service. Check your
						connection — or try the handle again.
					</p>
					<button
						type="button"
						onClick={() => lobby.refetch()}
						className="mt-8 rounded-full border border-[#cbb87f]/50 px-7 py-3 text-[#e9dcb4] text-[12px] uppercase tracking-[0.26em] transition-colors hover:bg-[#cbb87f]/15"
					>
						Try again
					</button>
				</div>
			) : null}

			{lobby.isSuccess ? (
				lobby.data.exhibitions.length === 0 ? (
					<div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
						<p className="font-museum text-4xl text-[#e8e2d5]">
							Nothing on display
						</p>
						<p className="mt-4 max-w-md text-sm text-white/50 leading-relaxed">
							No exhibitions have been published yet. The curators are still
							hanging the first show.
						</p>
					</div>
				) : (
					<section className="grid gap-5 px-8 pb-20 md:grid-cols-2 md:px-20 xl:grid-cols-3">
						{lobby.data.exhibitions.map((exhibition, i) => (
							<ExhibitionCard
								key={exhibition.id}
								exhibition={exhibition}
								index={i}
							/>
						))}
					</section>
				)
			) : null}
		</main>
	);
}

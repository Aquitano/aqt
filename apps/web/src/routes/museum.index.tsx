import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import type { LobbyGroup, LobbyMuseum } from "@/components/museum/types";
import { useTRPC } from "@/utils/trpc";

import "@/components/museum/museum.css";

export const Route = createFileRoute("/museum/")({
	component: LobbyPage,
	head: () => ({
		meta: [{ title: "The Museum — AQT Gallery" }],
	}),
});

const GROUP_KIND_LABEL: Record<string, string> = {
	exhibition: "Exhibition",
	artist_collection: "Artist collection",
	collection: "Collection",
	custom: "Collection",
};

function MuseumPanel({
	museum,
	index,
}: {
	museum: LobbyMuseum;
	index: number;
}) {
	return (
		<Link
			to="/museum/$kind/$slug"
			params={{ kind: "m", slug: museum.slug }}
			className="group relative block h-[72vh] min-h-[480px] w-full overflow-hidden"
			style={{ animationDelay: `${index * 120}ms` }}
		>
			{museum.coverImageUrl ? (
				<img
					src={museum.coverImageUrl}
					alt=""
					className="museum-kenburns absolute inset-0 h-full w-full object-cover"
					loading={index === 0 ? "eager" : "lazy"}
				/>
			) : (
				<div className="absolute inset-0 bg-[#181511]" />
			)}
			<div className="absolute inset-0 bg-gradient-to-t from-[#0b0a09] via-[#0b0a09]/45 to-[#0b0a09]/30 transition-opacity duration-700 group-hover:opacity-80" />
			<div className="absolute inset-0 flex flex-col items-start justify-end px-8 pb-14 md:px-20">
				<p className="museum-fade-up text-[#c9b687] text-[11px] uppercase tracking-[0.34em]">
					{museum.tagline ?? "Museum"}
				</p>
				<h2 className="museum-fade-up mt-3 max-w-3xl font-museum text-6xl text-[#f4efe3] leading-[0.98] md:text-8xl">
					{museum.name}
				</h2>
				<p className="museum-fade-up mt-5 max-w-xl text-[14px] text-white/60 leading-relaxed">
					{museum.description}
				</p>
				<div className="museum-fade-up mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-white/45 uppercase tracking-[0.22em]">
					<span>{museum.roomCount} rooms</span>
					<span aria-hidden>—</span>
					<span>{museum.artworkCount} artworks</span>
					{museum.roomNames.length > 0 ? (
						<>
							<span aria-hidden>—</span>
							<span className="text-white/40 normal-case tracking-normal">
								{museum.roomNames.join(" · ")}
							</span>
						</>
					) : null}
				</div>
				<span className="mt-8 inline-flex items-center gap-3 rounded-full border border-[#cbb87f]/50 bg-black/30 px-8 py-3.5 text-[#e9dcb4] text-[12px] uppercase tracking-[0.3em] backdrop-blur transition-all duration-300 group-hover:gap-5 group-hover:bg-[#cbb87f]/20">
					Enter the museum <span aria-hidden>→</span>
				</span>
			</div>
		</Link>
	);
}

function GroupCard({ group }: { group: LobbyGroup }) {
	return (
		<Link
			to="/museum/$kind/$slug"
			params={{ kind: "g", slug: group.slug }}
			className="group relative w-[320px] shrink-0 snap-start overflow-hidden rounded-2xl border border-white/8 bg-[#12100d] md:w-[380px]"
		>
			<div className="relative h-[230px] overflow-hidden">
				{group.coverImageUrl ? (
					<img
						src={group.coverImageUrl}
						alt=""
						loading="lazy"
						className="h-full w-full object-cover transition-transform duration-[1.4s] ease-out group-hover:scale-[1.07]"
					/>
				) : (
					<div className="h-full w-full bg-[#1a1713]" />
				)}
				<div className="absolute inset-0 bg-gradient-to-t from-[#12100d] to-transparent" />
				<span className="absolute top-4 left-4 rounded-full border border-white/15 bg-black/45 px-3 py-1 text-[10px] text-white/75 uppercase tracking-[0.22em] backdrop-blur">
					{GROUP_KIND_LABEL[group.kind] ?? "Collection"}
				</span>
			</div>
			<div className="px-6 pt-2 pb-7">
				<h3 className="font-museum text-3xl text-[#efe8d6] leading-tight">
					{group.name}
				</h3>
				<p className="mt-2 line-clamp-2 text-[13px] text-white/50 leading-relaxed">
					{group.tagline ?? group.description}
				</p>
				<p className="mt-4 text-[#b7a989] text-[11px] uppercase tracking-[0.24em]">
					{group.artworkCount} artworks · walk through →
				</p>
			</div>
		</Link>
	);
}

function LobbySkeleton() {
	return (
		<div aria-busy="true" className="space-y-1">
			<div className="museum-skeleton h-[72vh] min-h-[480px] w-full" />
			<div className="flex gap-4 px-8 py-14 md:px-20">
				{[0, 1, 2].map((i) => (
					<div
						key={i}
						className="museum-skeleton h-[330px] w-[320px] rounded-2xl md:w-[380px]"
					/>
				))}
			</div>
		</div>
	);
}

function LobbyPage() {
	const trpc = useTRPC();
	const lobby = useQuery(trpc.museum.lobby.queryOptions());

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
						to="/museum/studio"
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
				lobby.data.museums.length === 0 && lobby.data.groups.length === 0 ? (
					<div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
						<p className="font-museum text-4xl text-[#e8e2d5]">
							Nothing on display
						</p>
						<p className="mt-4 max-w-md text-sm text-white/50 leading-relaxed">
							No museums or collections have been published yet. The curators
							are still hanging the first show.
						</p>
					</div>
				) : (
					<>
						<div className="space-y-1">
							{lobby.data.museums.map((museum, i) => (
								<MuseumPanel key={museum.id} museum={museum} index={i} />
							))}
						</div>

						{lobby.data.groups.length > 0 ? (
							<section className="px-8 pt-14 pb-20 md:px-20">
								<div className="flex items-end justify-between">
									<div>
										<p className="text-[#b7a989] text-[11px] uppercase tracking-[0.3em]">
											Beyond the permanent halls
										</p>
										<h2 className="mt-2 font-museum text-4xl text-[#f0e9d8]">
											Exhibitions & Collections
										</h2>
									</div>
								</div>
								<div className="mt-8 flex snap-x gap-5 overflow-x-auto pb-4 [scrollbar-width:thin]">
									{lobby.data.groups.map((group) => (
										<GroupCard key={group.id} group={group} />
									))}
								</div>
							</section>
						) : null}
					</>
				)
			) : null}
		</main>
	);
}

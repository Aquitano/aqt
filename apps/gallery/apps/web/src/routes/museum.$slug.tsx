import { env } from "@aqt-gallery/env/web";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { useVisitAnalytics } from "@/components/museum/analytics";
import {
	exhibitionToContent,
	type GalleryContent,
} from "@/components/museum/types";
import { useTRPC } from "@/utils/trpc";

import "@/components/museum/museum.css";

const MuseumExperience = lazy(
	() => import("@/components/museum/museum-experience"),
);

type MuseumSearch = { artwork?: string };

export const Route = createFileRoute("/museum/$slug")({
	component: GalleryPage,
	validateSearch: (search: Record<string, unknown>): MuseumSearch => {
		const artwork = search.artwork;
		return typeof artwork === "string" && artwork.length > 0 ? { artwork } : {};
	},
	notFoundComponent: () => (
		<FullScreenMessage
			title="No such hall"
			body="This exhibition doesn't exist."
		/>
	),
	// Fetch just the meta fields server-side so crawlers see a rich preview.
	// Resilient by design: a miss/error degrades to the generic title rather
	// than failing the route.
	loader: async ({ context, params }) => {
		try {
			const meta = await context.queryClient.ensureQueryData(
				context.trpc.exhibitions.shareMeta.queryOptions({ slug: params.slug }),
			);
			return { meta };
		} catch {
			return { meta: null };
		}
	},
	head: ({ params, loaderData }) => {
		const meta = loaderData?.meta;
		if (!meta) {
			return { meta: [{ title: "Exhibition — AQT Gallery" }] };
		}
		const ogImage = `${env.VITE_SERVER_URL}/og-image/${params.slug}`;
		const description =
			meta.tagline ||
			meta.description ||
			"Step inside and walk through this exhibition in 3D.";
		return {
			meta: [
				{ title: `${meta.name} — AQT Gallery` },
				{ name: "description", content: description },
				{ property: "og:type", content: "website" },
				{ property: "og:title", content: meta.name },
				{ property: "og:description", content: description },
				{ property: "og:image", content: ogImage },
				{ name: "twitter:card", content: "summary_large_image" },
				{ name: "twitter:title", content: meta.name },
				{ name: "twitter:description", content: description },
				{ name: "twitter:image", content: ogImage },
			],
		};
	},
});

function FullScreenMessage({
	title,
	body,
	retry,
}: {
	title: string;
	body: string;
	retry?: () => void;
}) {
	return (
		<div className="flex h-screen flex-col items-center justify-center bg-[#0b0a09] px-6 text-center text-white">
			<p className="font-museum text-4xl text-[#e8e2d5]">{title}</p>
			<p className="mt-4 max-w-md text-sm text-white/50 leading-relaxed">
				{body}
			</p>
			<div className="mt-8 flex items-center gap-4">
				{retry ? (
					<button
						type="button"
						onClick={retry}
						className="rounded-full border border-[#cbb87f]/50 px-7 py-3 text-[#e9dcb4] text-[12px] uppercase tracking-[0.26em] transition-colors hover:bg-[#cbb87f]/15"
					>
						Try again
					</button>
				) : null}
				<Link
					to="/museum"
					className="rounded-full border border-white/20 px-7 py-3 text-[12px] text-white/70 uppercase tracking-[0.26em] transition-colors hover:border-white/50 hover:text-white"
				>
					Back to the lobby
				</Link>
			</div>
		</div>
	);
}

function LoadingScreen() {
	return (
		<div className="flex h-screen flex-col items-center justify-center bg-[#0b0a09]">
			<div className="h-10 w-10 animate-spin rounded-full border-2 border-white/15 border-t-[#cbb87f]" />
			<p className="mt-6 text-[11px] text-white/45 uppercase tracking-[0.3em]">
				Opening the exhibition…
			</p>
		</div>
	);
}

function GalleryPage() {
	const { slug } = Route.useParams();
	const { artwork: deepLinkArtworkId } = Route.useSearch();
	const trpc = useTRPC();

	// 3D canvas is client-only; render after mount to keep SSR happy.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

	// A published exhibition's content is fixed for the length of a visit, and
	// the world layout is rebuilt whenever this query data changes identity — so
	// never treat it as stale. Owners arriving from the studio see edits via the
	// explicit invalidation the studio already fires on save.
	const query = useQuery({
		...trpc.exhibitions.bySlug.queryOptions({ slug }),
		staleTime: Number.POSITIVE_INFINITY,
	});

	// Rebuild the gallery content only when the underlying query data changes —
	// not on every render. MuseumExperience derives the (expensive) world layout
	// from this object's identity, so a fresh object each render would rebuild
	// the whole scene graph.
	const content = useMemo<GalleryContent | null>(
		() => (query.data ? exhibitionToContent(query.data) : null),
		[query.data],
	);

	// Anonymous visit counters, only for genuine public views: published, and
	// not the owner previewing their own exhibition (which the payload flags).
	useVisitAnalytics(
		"exhibition",
		query.data?.id ?? null,
		Boolean(query.data?.isPublished && !query.data.isOwner),
	);

	if (!mounted || query.isPending) {
		return <LoadingScreen />;
	}

	if (query.isError) {
		return (
			<FullScreenMessage
				title="The lights went out"
				body="We couldn't load this exhibition from the collection service. Check your connection and try again."
				retry={() => query.refetch()}
			/>
		);
	}

	if (!content) {
		return (
			<FullScreenMessage
				title="No such hall"
				body="This exhibition doesn't exist — or hasn't been published yet."
			/>
		);
	}

	const isDraftPreview = query.data ? !query.data.isPublished : false;

	return (
		<Suspense fallback={<LoadingScreen />}>
			<Link
				to="/exhibit/$slug"
				params={{ slug }}
				className="fixed top-5 right-5 z-40 rounded-full border border-white/30 bg-black/50 px-4 py-2 text-white text-xs uppercase tracking-[0.18em] backdrop-blur transition-colors hover:bg-black/70"
			>
				View in 2D
			</Link>
			<MuseumExperience
				key={content.id}
				content={content}
				deepLinkArtworkId={deepLinkArtworkId}
			/>
			{isDraftPreview ? (
				<div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center pt-4">
					<span className="rounded-full border border-[#cbb87f]/40 bg-black/60 px-5 py-2 text-[#e9dcb4] text-[11px] uppercase tracking-[0.24em] backdrop-blur">
						Draft preview — only you can see this exhibition
					</span>
				</div>
			) : null}
		</Suspense>
	);
}

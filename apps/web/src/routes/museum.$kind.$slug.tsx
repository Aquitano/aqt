import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";

import {
	type GalleryContent,
	groupToContent,
	museumToContent,
} from "@/components/museum/types";
import { useTRPC } from "@/utils/trpc";

import "@/components/museum/museum.css";

const MuseumExperience = lazy(
	() => import("@/components/museum/museum-experience"),
);

export const Route = createFileRoute("/museum/$kind/$slug")({
	component: GalleryPage,
	params: {
		parse: (params) => {
			if (params.kind !== "m" && params.kind !== "g") {
				throw new Error(`Unknown gallery kind: ${params.kind}`);
			}
			return params as { kind: "m" | "g"; slug: string };
		},
	},
	head: () => ({
		meta: [{ title: "Gallery — AQT Gallery" }],
	}),
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
				Opening the gallery…
			</p>
		</div>
	);
}

function GalleryPage() {
	const { kind, slug } = Route.useParams();
	const trpc = useTRPC();

	// 3D canvas is client-only; render after mount to keep SSR happy.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

	const museumQuery = useQuery({
		...trpc.museum.museum.queryOptions({ slug }),
		enabled: kind === "m",
	});
	const groupQuery = useQuery({
		...trpc.museum.group.queryOptions({ slug }),
		enabled: kind === "g",
	});
	const query = kind === "m" ? museumQuery : groupQuery;

	if (!mounted || query.isPending) {
		return <LoadingScreen />;
	}

	if (query.isError) {
		return (
			<FullScreenMessage
				title="The lights went out"
				body="We couldn't load this gallery from the collection service. Check your connection and try again."
				retry={() => query.refetch()}
			/>
		);
	}

	const content: GalleryContent | null =
		kind === "m"
			? museumQuery.data
				? museumToContent(museumQuery.data)
				: null
			: groupQuery.data
				? groupToContent(groupQuery.data)
				: null;

	if (!content) {
		return (
			<FullScreenMessage
				title="No such hall"
				body="This museum or collection doesn't exist — or hasn't been published yet."
			/>
		);
	}

	const isDraftPreview =
		kind === "g" && groupQuery.data ? !groupQuery.data.isPublished : false;

	return (
		<Suspense fallback={<LoadingScreen />}>
			<MuseumExperience key={content.id} content={content} />
			{isDraftPreview ? (
				<div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center pt-4">
					<span className="rounded-full border border-[#cbb87f]/40 bg-black/60 px-5 py-2 text-[#e9dcb4] text-[11px] uppercase tracking-[0.24em] backdrop-blur">
						Draft preview — only you can see this gallery
					</span>
				</div>
			) : null}
		</Suspense>
	);
}

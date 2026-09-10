import { Button } from "@aqt-gallery/ui/components/button";
import { Input } from "@aqt-gallery/ui/components/input";
import { cn } from "@aqt-gallery/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { CalendarDays, MapPin, Sparkles } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
import {
	type JournalEditor,
	JournalEditorDialog,
} from "@/components/journal/journal-editor-dialog";
import { getUser } from "@/functions/get-user";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/journal")({
	component: JournalPage,
	beforeLoad: async () => ({ session: await getUser() }),
	loader: async ({ context }) => {
		if (!context.session) throw redirect({ to: "/login" });
	},
});

const dateFormatter = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
	year: "numeric",
});

function displayDate(value: Date | string) {
	return dateFormatter.format(new Date(value));
}

function JournalPage() {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const archive = useQuery(trpc.artworks.list.queryOptions());
	const history = useQuery(trpc.journal.overview.queryOptions());
	const visits = useQuery(trpc.journal.visits.list.queryOptions());
	const collections = useQuery(trpc.journal.collections.list.queryOptions());
	const createVisit = useMutation(trpc.journal.visits.create.mutationOptions());
	const createCollection = useMutation(
		trpc.journal.collections.create.mutationOptions(),
	);
	const [visitTitle, setVisitTitle] = useState("");
	const [venueName, setVenueName] = useState("");
	const [city, setCity] = useState("");
	const [collectionName, setCollectionName] = useState("");
	const [collectionDescription, setCollectionDescription] = useState("");
	const [editor, setEditor] = useState<JournalEditor | null>(null);
	const [placeFilter, setPlaceFilter] = useState<string | null>(null);
	const [artistFilter, setArtistFilter] = useState<string | null>(null);
	const filteredHistory = useMemo(
		() =>
			history.data?.visits.filter(
				(entry) =>
					(!placeFilter || entry.placeLabel === placeFilter) &&
					(!artistFilter ||
						entry.artworks.some((work) => work.artist === artistFilter)),
			) ?? [],
		[artistFilter, history.data?.visits, placeFilter],
	);
	const archiveById = useMemo(
		() => new Map(archive.data?.map((entry) => [entry.id, entry]) ?? []),
		[archive.data],
	);

	const refreshEditor = async (kind: JournalEditor["kind"]) => {
		if (kind === "collection") {
			await queryClient.invalidateQueries(
				trpc.journal.collections.pathFilter(),
			);
			return;
		}
		await Promise.all([
			queryClient.invalidateQueries(trpc.journal.overview.pathFilter()),
			queryClient.invalidateQueries(trpc.journal.visits.pathFilter()),
		]);
	};

	const addVisit = async () => {
		if (!visitTitle.trim()) return;
		await createVisit.mutateAsync({
			title: visitTitle.trim(),
			venueName: venueName.trim() || null,
			city: city.trim() || null,
		});
		setVisitTitle("");
		setVenueName("");
		setCity("");
		await refreshEditor("visit");
		toast.success("Visit added to your journal");
	};
	const addCollection = async () => {
		if (!collectionName.trim()) return;
		await createCollection.mutateAsync({
			name: collectionName.trim(),
			description: collectionDescription.trim() || null,
		});
		setCollectionName("");
		setCollectionDescription("");
		await refreshEditor("collection");
		toast.success("Collection created");
	};

	return (
		<CosmosShell active="journal">
			<div className="mx-auto grid w-full max-w-[1320px] gap-10 pt-8 lg:grid-cols-2">
				<section className="lg:col-span-2">
					<div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_360px] lg:items-end">
						<div>
							<p className="font-medium text-muted-foreground text-xs">
								Your art life
							</p>
							<h1 className="mt-2 max-w-2xl font-semibold text-4xl tracking-[-0.03em] sm:text-5xl">
								Every encounter, connected.
							</h1>
							<p className="mt-3 max-w-xl text-muted-foreground text-sm leading-6">
								Return to the places you visited, the works that stayed with
								you, and the selections taking shape across your archive.
							</p>
						</div>
						<div className="grid grid-cols-3 gap-4 rounded-2xl bg-card p-5">
							<Metric label="Visits" value={history.data?.visits.length ?? 0} />
							<Metric label="Places" value={history.data?.places.length ?? 0} />
							<Metric
								label="Works saved"
								value={history.data?.artworkCount ?? 0}
							/>
						</div>
					</div>
					<HistoryExplorer
						visits={filteredHistory}
						places={history.data?.places ?? []}
						artists={history.data?.artists ?? []}
						placeFilter={placeFilter}
						artistFilter={artistFilter}
						onPlaceFilter={setPlaceFilter}
						onArtistFilter={setArtistFilter}
						onEdit={(id) => {
							const entry = visits.data?.find((visit) => visit.id === id);
							if (entry)
								setEditor({
									kind: "visit",
									id,
									name: entry.title,
									artworkIds: entry.artworkIds,
								});
						}}
					/>
				</section>
				<section>
					<p className="font-medium text-muted-foreground text-xs">
						Field journal
					</p>
					<h1 className="mt-1 font-semibold text-3xl tracking-[-0.03em]">
						Visits
					</h1>
					<p className="mt-2 max-w-lg text-muted-foreground text-sm leading-6">
						Keep the places, exhibitions, and artworks you encountered together.
						An artwork can appear in any number of visits.
					</p>
					<div className="mt-5 grid gap-2 rounded-2xl bg-card p-5 sm:grid-cols-3">
						<Input
							placeholder="Visit or exhibition"
							value={visitTitle}
							onChange={(event) => setVisitTitle(event.target.value)}
						/>
						<Input
							placeholder="Venue"
							value={venueName}
							onChange={(event) => setVenueName(event.target.value)}
						/>
						<div className="flex gap-2">
							<Input
								className="min-w-0 flex-1"
								placeholder="City"
								value={city}
								onChange={(event) => setCity(event.target.value)}
							/>
							<Button
								onClick={() => void addVisit()}
								disabled={createVisit.isPending}
							>
								Add
							</Button>
						</div>
					</div>
					<div className="mt-4 grid gap-1">
						{visits.data?.map((entry) => (
							<EntryCard
								key={entry.id}
								name={entry.title}
								detail={[entry.venueName, entry.city]
									.filter(Boolean)
									.join(" · ")}
								count={entry.artworkIds.length}
								onEdit={() =>
									setEditor({
										kind: "visit",
										id: entry.id,
										name: entry.title,
										artworkIds: entry.artworkIds,
									})
								}
							/>
						))}
						{visits.isSuccess && visits.data.length === 0 ? (
							<EmptyCopy>
								Start with the last exhibition, gallery, or studio visit you
								remember.
							</EmptyCopy>
						) : null}
					</div>
				</section>
				<section>
					<p className="font-medium text-muted-foreground text-xs">
						Your selections
					</p>
					<h1 className="mt-1 font-semibold text-3xl tracking-[-0.03em]">
						Collections
					</h1>
					<p className="mt-2 max-w-lg text-muted-foreground text-sm leading-6">
						Build a private exhibition from your archive. Publishing remains
						unavailable until sharing has its own deliberate workflow.
					</p>
					<div className="mt-5 rounded-2xl bg-card p-5">
						<div className="grid gap-2 sm:grid-cols-2">
							<Input
								placeholder="Collection name"
								value={collectionName}
								onChange={(event) => setCollectionName(event.target.value)}
							/>
							<Input
								placeholder="Short description"
								value={collectionDescription}
								onChange={(event) =>
									setCollectionDescription(event.target.value)
								}
							/>
						</div>
						<div className="mt-4 flex items-center justify-between gap-3">
							<p className="text-muted-foreground text-sm">
								Private. Publishing unavailable.
							</p>
							<Button
								onClick={() => void addCollection()}
								disabled={createCollection.isPending}
							>
								Create
							</Button>
						</div>
					</div>
					<div className="mt-4 grid gap-4">
						{collections.data?.map((entry) => (
							<CollectionCard
								key={entry.id}
								collection={entry}
								archiveById={archiveById}
								onEdit={() =>
									setEditor({
										kind: "collection",
										id: entry.id,
										name: entry.name,
										description: entry.description,
										artworkIds: entry.artworkIds,
										artworkNotes: entry.artworkNotes,
										coverArtworkId: entry.coverArtworkId,
									})
								}
							/>
						))}
						{collections.isSuccess && collections.data.length === 0 ? (
							<EmptyCopy>
								Your best works can live here without becoming a public
								exhibition.
							</EmptyCopy>
						) : null}
					</div>
				</section>
			</div>
			{editor ? (
				<JournalEditorDialog
					key={`${editor.kind}-${editor.id}`}
					editor={editor}
					archive={archive.data ?? []}
					onClose={() => setEditor(null)}
					onSaved={refreshEditor}
				/>
			) : null}
		</CosmosShell>
	);
}

function EntryCard({
	name,
	detail,
	count,
	onEdit,
}: {
	name: string;
	detail: string;
	count: number;
	onEdit: () => void;
}) {
	return (
		<div className="-mx-3 flex items-center justify-between gap-4 rounded-xl px-3 py-2 transition-colors hover:bg-secondary/60">
			<div className="min-w-0">
				<h2 className="truncate font-medium text-sm">{name}</h2>
				<p className="mt-0.5 truncate text-muted-foreground text-sm">
					{detail || "No location added"} · {count} artworks
				</p>
			</div>
			<Button variant="ghost" size="sm" onClick={onEdit}>
				Edit artworks
			</Button>
		</div>
	);
}
function EmptyCopy({ children }: { children: React.ReactNode }) {
	return (
		<p className="rounded-2xl border border-border border-dashed p-5 text-muted-foreground text-sm">
			{children}
		</p>
	);
}

function Metric({ label, value }: { label: string; value: number }) {
	return (
		<div className="min-w-0">
			<p className="truncate text-muted-foreground text-xs">{label}</p>
			<p className="mt-1 font-semibold text-2xl tracking-[-0.02em]">{value}</p>
		</div>
	);
}

type HistoryArtwork = {
	id: string;
	title: string;
	artist: string | null;
	imageUrl: string | null;
	thumbnailUrl: string | null;
};
type HistoryVisit = {
	id: string;
	title: string;
	placeLabel: string;
	startedAt: Date | string;
	artworks: HistoryArtwork[];
};
type PlaceFilter = { label: string; visitCount: number; artworkCount: number };
type ArtistFilter = { name: string; artworkCount: number };

function HistoryExplorer({
	visits,
	places,
	artists,
	placeFilter,
	artistFilter,
	onPlaceFilter,
	onArtistFilter,
	onEdit,
}: {
	visits: HistoryVisit[];
	places: PlaceFilter[];
	artists: ArtistFilter[];
	placeFilter: string | null;
	artistFilter: string | null;
	onPlaceFilter: (value: string | null) => void;
	onArtistFilter: (value: string | null) => void;
	onEdit: (id: string) => void;
}) {
	return (
		<div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
			<section>
				<div className="flex items-center justify-between gap-4">
					<div>
						<p className="font-medium text-muted-foreground text-xs">
							Explore your history
						</p>
						<h2 className="mt-1 font-semibold text-lg tracking-[-0.02em]">
							A timeline of what you saw.
						</h2>
					</div>
					{placeFilter || artistFilter ? (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								onPlaceFilter(null);
								onArtistFilter(null);
							}}
						>
							Clear filters
						</Button>
					) : null}
				</div>
				{visits.length > 0 ? (
					<div className="mt-6 grid gap-6">
						{visits.map((entry) => (
							<article
								key={entry.id}
								className="grid gap-3 sm:grid-cols-[108px_minmax(0,1fr)]"
							>
								<time className="flex items-start gap-2 text-muted-foreground text-sm">
									<CalendarDays className="mt-0.5 size-4" />
									{displayDate(entry.startedAt)}
								</time>
								<div className="rounded-2xl bg-card p-5">
									<div className="flex flex-wrap items-start justify-between gap-3">
										<div>
											<h3 className="font-semibold text-lg tracking-[-0.02em]">
												{entry.title}
											</h3>
											{entry.placeLabel ? (
												<p className="mt-1 flex items-center gap-1.5 text-muted-foreground text-sm">
													<MapPin className="size-3.5" />
													{entry.placeLabel}
												</p>
											) : null}
										</div>
										<Button
											variant="ghost"
											size="sm"
											onClick={() => onEdit(entry.id)}
										>
											Edit
										</Button>
									</div>
									{entry.artworks.length > 0 ? (
										<div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
											{entry.artworks.map((artwork) => (
												<HistoryArtworkCard
													key={artwork.id}
													artwork={artwork}
												/>
											))}
										</div>
									) : (
										<p className="mt-4 rounded-xl border border-border border-dashed p-4 text-muted-foreground text-sm">
											No works connected yet. Edit this visit to add them.
										</p>
									)}
								</div>
							</article>
						))}
					</div>
				) : (
					<JournalEmpty
						icon={<CalendarDays />}
						title="Your history starts with one visit."
						body="Add a gallery, museum, or studio visit and connect the works you want to remember."
					/>
				)}
			</section>
			<aside className="grid content-start gap-4">
				<FilterList
					title="Places"
					items={places.map((place) => ({
						value: place.label,
						detail: `${place.visitCount} visits · ${place.artworkCount} works`,
					}))}
					active={placeFilter}
					onSelect={onPlaceFilter}
				/>
				<FilterList
					title="Artists you encountered"
					items={artists.map((artist) => ({
						value: artist.name,
						detail: `${artist.artworkCount} works`,
					}))}
					active={artistFilter}
					onSelect={onArtistFilter}
				/>
			</aside>
		</div>
	);
}

function FilterList({
	title,
	items,
	active,
	onSelect,
}: {
	title: string;
	items: { value: string; detail: string }[];
	active: string | null;
	onSelect: (value: string | null) => void;
}) {
	return (
		<section className="rounded-2xl bg-card p-4">
			<div className="flex items-center justify-between gap-2">
				<h3 className="font-medium text-sm">{title}</h3>
				{active ? (
					<Button variant="ghost" size="xs" onClick={() => onSelect(null)}>
						Clear
					</Button>
				) : null}
			</div>
			<div className="-mx-1.5 mt-3 grid gap-0.5">
				{items.length > 0 ? (
					items.map((item) => (
						<button
							key={item.value}
							type="button"
							onClick={() =>
								onSelect(active === item.value ? null : item.value)
							}
							className={cn(
								"flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-secondary/60",
								active === item.value && "bg-secondary text-foreground",
							)}
						>
							<span className="truncate">{item.value}</span>
							<span className="shrink-0 text-muted-foreground text-xs">
								{item.detail}
							</span>
						</button>
					))
				) : (
					<p className="px-3 text-muted-foreground text-sm">
						No encounters yet.
					</p>
				)}
			</div>
		</section>
	);
}

function HistoryArtworkCard({ artwork }: { artwork: HistoryArtwork }) {
	return (
		<Link
			to="/artworks/$artworkId"
			params={{ artworkId: artwork.id }}
			className="group block"
		>
			<div className="aspect-[4/3] overflow-hidden rounded-lg bg-secondary">
				{artwork.thumbnailUrl || artwork.imageUrl ? (
					<img
						src={artwork.thumbnailUrl ?? artwork.imageUrl ?? undefined}
						alt=""
						className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
						loading="lazy"
					/>
				) : null}
			</div>
			<div className="pt-2">
				<p className="line-clamp-1 font-medium text-sm">{artwork.title}</p>
				<p className="line-clamp-1 text-muted-foreground text-xs">
					{artwork.artist || "Unknown artist"}
				</p>
			</div>
		</Link>
	);
}

function JournalEmpty({
	icon,
	title,
	body,
}: {
	icon: ReactNode;
	title: string;
	body: string;
}) {
	return (
		<div className="mt-6 flex min-h-56 flex-col items-center justify-center rounded-2xl border border-border border-dashed px-6 text-center">
			<div className="text-muted-foreground [&_svg]:size-6">{icon}</div>
			<h3 className="mt-3 font-semibold text-lg tracking-[-0.02em]">{title}</h3>
			<p className="mt-2 max-w-sm text-muted-foreground text-sm leading-6">
				{body}
			</p>
		</div>
	);
}

type CollectionArtwork = {
	id: string;
	title: string;
	artist: string | null;
	originalUrl: string | null;
	thumbnailUrl: string | null;
};

function CollectionCard({
	collection,
	archiveById,
	onEdit,
}: {
	collection: {
		id: string;
		name: string;
		description: string | null;
		coverArtworkId: string | null;
		artworkIds: string[];
	};
	archiveById: Map<string, CollectionArtwork>;
	onEdit: () => void;
}) {
	const works = collection.artworkIds
		.map((id) => archiveById.get(id))
		.filter((work): work is CollectionArtwork => Boolean(work));
	const cover = collection.coverArtworkId
		? works.find((work) => work.id === collection.coverArtworkId)
		: null;
	const coverFirst = cover
		? [cover, ...works.filter((work) => work.id !== cover.id)]
		: works;
	return (
		<article className="rounded-2xl bg-card p-4">
			<div className="grid aspect-[1.65] grid-cols-2 gap-1 overflow-hidden rounded-xl">
				{coverFirst
					.slice(0, 4)
					.map((work) =>
						work.thumbnailUrl || work.originalUrl ? (
							<img
								key={work.id}
								src={work.thumbnailUrl ?? work.originalUrl ?? undefined}
								alt=""
								className="h-full w-full object-cover"
								loading="lazy"
							/>
						) : (
							<div key={work.id} className="bg-secondary" />
						),
					)}
				{works.length === 0 ? (
					<div className="col-span-2 flex items-center justify-center bg-secondary text-muted-foreground text-sm">
						<Sparkles className="mr-2 size-4" />
						Add your first work
					</div>
				) : null}
			</div>
			<div className="pt-4">
				<div className="flex items-start justify-between gap-3">
					<div>
						<h2 className="font-semibold text-lg tracking-[-0.02em]">
							{collection.name}
						</h2>
						<p className="mt-1 line-clamp-2 text-muted-foreground text-sm">
							{collection.description || "A personal selection."}
						</p>
					</div>
					<span className="shrink-0 text-muted-foreground text-xs">
						Private. Publishing unavailable.
					</span>
				</div>
				<div className="mt-4 flex items-center justify-between">
					<span className="text-muted-foreground text-xs">
						{works.length} {works.length === 1 ? "work" : "works"}
					</span>
					<div className="flex gap-2">
						<Button
							variant="ghost"
							size="sm"
							nativeButton={false}
							render={
								<Link
									to="/collection/$collectionId"
									params={{ collectionId: collection.id }}
								/>
							}
						>
							Explore
						</Button>
						<Button size="sm" variant="outline" onClick={onEdit}>
							Curate
						</Button>
					</div>
				</div>
			</div>
		</article>
	);
}

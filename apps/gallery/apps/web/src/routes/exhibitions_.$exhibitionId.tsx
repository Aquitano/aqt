import { env } from "@aqt-gallery/env/web";
import {
	analyzeWorld,
	buildWorldLayout,
	type RoomAnalysis,
	type WorldInput,
} from "@aqt-gallery/gallery-layout";
import { Button } from "@aqt-gallery/ui/components/button";
import { Input } from "@aqt-gallery/ui/components/input";
import { Label } from "@aqt-gallery/ui/components/label";
import { Textarea } from "@aqt-gallery/ui/components/textarea";
import { cn } from "@aqt-gallery/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	redirect,
	useNavigate,
} from "@tanstack/react-router";
import {
	Check,
	ChevronDown,
	ChevronUp,
	Footprints,
	GripVertical,
	Plus,
	Star,
	Trash2,
	TriangleAlert,
	Upload,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { GalleryThemePanel } from "@/components/gallery/gallery-theme-panel";
import { useImportController } from "@/components/gallery/import-provider";
import {
	LintPanel,
	lintArtworkAnchor,
	lintRoomAnchor,
	PublishButton,
} from "@/components/gallery/lint-panel";
import {
	type ArchiveArtwork,
	type ExhibitionCuration,
	type ExhibitionDetails,
	type RoomView,
	useExhibitionCuration,
} from "@/components/gallery/use-exhibition-curation";
import { VisitStatsStrip } from "@/components/gallery/visit-stats-strip";
import {
	toLayoutArtwork,
	type WallEditorArtwork,
	WallPlacementEditor,
} from "@/components/gallery/wall-placement-editor";
import { FloorPlan } from "@/components/museum/floor-plan";
import { type CuratedKind, KIND_LABEL } from "@/components/museum/types";
import { getUser } from "@/functions/get-user";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/exhibitions_/$exhibitionId")({
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
	const { exhibitionId } = Route.useParams();
	const [search, setSearch] = useState("");
	return (
		<CosmosShell active="explore" search={search} onSearch={setSearch}>
			<StudioBody exhibitionId={exhibitionId} search={search} />
		</CosmosShell>
	);
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<p className="font-medium text-muted-foreground text-xs">{children}</p>
	);
}

function thumbUrl(a: { thumbnailUrl: string | null }) {
	return a.thumbnailUrl ? `${env.VITE_SERVER_URL}${a.thumbnailUrl}` : null;
}

/** Resolve a room's ordered members + their curated placements into the shape
 * the wall editor and the shared layout math consume. */
function roomEditorArtworks(room: RoomView): WallEditorArtwork[] {
	return room.members.map((a) => {
		const p = room.placementById.get(a.id);
		return {
			id: a.id,
			title: a.title,
			thumbnailUrl: thumbUrl(a),
			dimensions: a.dimensions,
			imageWidth: a.width,
			imageHeight: a.height,
			wall: p?.wall ?? null,
			wallOffset: p?.wallOffset ?? null,
			scale: p?.scale ?? null,
		};
	});
}

const EMPTY_DETAILS: ExhibitionDetails = {
	name: "",
	tagline: "",
	description: "",
	kind: "custom",
};

function StudioBody({
	exhibitionId,
	search,
}: {
	exhibitionId: string;
	search: string;
}) {
	const navigate = useNavigate();
	const trpc = useTRPC();
	const { openImport, setImportTarget } = useImportController();
	const curation = useExhibitionCuration(exhibitionId);
	const { exhibition, rooms, available, busy } = curation;

	const statsQuery = useQuery({
		...trpc.exhibitions.stats.queryOptions({ id: exhibitionId }),
		enabled: Boolean(exhibition?.isPublished),
	});

	const query = search.trim().toLowerCase();
	const visibleAvailable = query
		? available.filter(
				(a) =>
					a.title.toLowerCase().includes(query) ||
					(a.artist ?? "").toLowerCase().includes(query),
			)
		: available;

	const [details, setDetails] = useState<ExhibitionDetails>(EMPTY_DETAILS);
	const [newRoomName, setNewRoomName] = useState("");
	// Which room the archive picker (and an import) adds to.
	const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const pickerRef = useRef<HTMLDivElement | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only on exhibition switch
	useEffect(() => {
		if (exhibition) {
			setDetails({
				name: exhibition.name,
				tagline: exhibition.tagline ?? "",
				description: exhibition.description ?? "",
				kind: exhibition.kind,
			});
		}
	}, [exhibition?.id]);

	// Keep a valid add-target: default to the first room, and recover if the
	// active room is deleted.
	useEffect(() => {
		const roomIds = rooms.map((r) => r.id);
		if (activeRoomId && roomIds.includes(activeRoomId)) return;
		setActiveRoomId(roomIds[0] ?? null);
	}, [rooms, activeRoomId]);

	const activeRoom = rooms.find((r) => r.id === activeRoomId) ?? null;
	const singleRoom = rooms.length === 1;

	// Imports land in the active room while the studio is open, so the header
	// button and the `i` shortcut both hang straight in here. The ref keeps the
	// registered callback off the per-render `addToRoom` identity.
	const addToRoomRef = useRef(curation.addToRoom);
	useEffect(() => {
		addToRoomRef.current = curation.addToRoom;
	});
	const exhibitionName = exhibition?.name;
	const activeRoomName = activeRoom?.name;
	useEffect(() => {
		if (!exhibitionName || !activeRoomId || !activeRoomName) return;
		const roomId = activeRoomId;
		setImportTarget({
			label: singleRoom
				? exhibitionName
				: `${exhibitionName} · ${activeRoomName}`,
			onImported: (ids) => addToRoomRef.current(roomId, ids),
		});
		return () => setImportTarget(null);
	}, [
		exhibitionName,
		activeRoomId,
		activeRoomName,
		singleRoom,
		setImportTarget,
	]);

	// Door walls and cell sizes depend on the whole floor plan, so analyse the
	// exhibition once and hand each room its own loads (a room split into wings
	// shows its first wing) — matching lint's overflow math.
	const worldInput = useMemo<WorldInput>(
		() => ({
			rooms: rooms.map((room) => ({
				id: room.id,
				name: room.name,
				description: room.description,
				layout: room.layout,
				artworks: roomEditorArtworks(room).map((a) => ({
					id: a.id,
					...toLayoutArtwork(a),
				})),
			})),
		}),
		[rooms],
	);
	// Wall loads for one room given a candidate hang (the editor calls this on
	// every drag move). The whole plan is re-run because door walls and cell
	// sizes depend on the neighbours; a room split into wings reports its first.
	const analyzeRoom = useCallback(
		(roomId: string, artworks: WallEditorArtwork[]): RoomAnalysis | null => {
			const rooms = worldInput.rooms.map((room) =>
				room.id === roomId
					? {
							...room,
							artworks: artworks.map((a) => ({
								id: a.id,
								...toLayoutArtwork(a),
							})),
						}
					: room,
			);
			return analyzeWorld({ rooms }).find((a) => a.sourceId === roomId) ?? null;
		},
		[worldInput],
	);
	const floorPlan = useMemo(() => {
		const world = buildWorldLayout(worldInput);
		return world.paintings.length > 0 ? world : null;
	}, [worldInput]);

	// When no cover is chosen, the server falls back to the first hung artwork
	// (first room with members), so highlight that one as the implicit cover —
	// matching the card/lobby display.
	const implicitCoverId =
		rooms.find((r) => r.members.length > 0)?.members[0]?.id ?? null;

	const toggleSelected = (id: string) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});

	const addSelected = () => {
		if (!activeRoomId) return;
		const toAdd = available.filter((a) => selected.has(a.id)).map((a) => a.id);
		if (toAdd.length === 0) return;
		setSelected(new Set());
		curation.addToRoom(activeRoomId, toAdd);
	};

	const focusPicker = (roomId: string) => {
		setActiveRoomId(roomId);
		pickerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	const addRoom = () =>
		void curation.addRoom(newRoomName).then((created) => {
			setNewRoomName("");
			if (created) setActiveRoomId(created.id);
		});

	if (curation.loaded && !exhibition) {
		return (
			<div className="mx-auto w-full max-w-[1120px] pt-20">
				<div className="flex max-w-xl flex-col items-start gap-4">
					<h1 className="font-semibold text-3xl tracking-[-0.03em]">
						Exhibition not found.
					</h1>
					<p className="text-muted-foreground text-sm">
						This exhibition may have been deleted, or it belongs to another
						account.
					</p>
					<Button
						variant="outline"
						nativeButton={false}
						render={
							<Link to="/explore" search={{ view: "spaces" }}>
								← Back to explore
							</Link>
						}
					/>
				</div>
			</div>
		);
	}

	return (
		<div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 pt-10">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0">
					<SectionLabel>
						{exhibition ? KIND_LABEL[exhibition.kind] : "Exhibition"}
					</SectionLabel>
					<h1 className="mt-2 truncate font-semibold text-3xl tracking-[-0.03em]">
						{exhibition?.name ?? "Exhibition"}
					</h1>
					{exhibition?.tagline ? (
						<p className="mt-2 text-muted-foreground text-sm">
							{exhibition.tagline}
						</p>
					) : null}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{exhibition ? (
						<Button
							variant="outline"
							nativeButton={false}
							render={
								<Link to="/museum/$slug" params={{ slug: exhibition.slug }} />
							}
						>
							<Footprints />
							Walk in 3D
						</Button>
					) : null}
					<PublishButton
						isPublished={exhibition?.isPublished ?? false}
						report={curation.lint}
						disabled={busy || !exhibition}
						onToggle={curation.togglePublish}
					/>
					<Button
						variant="destructive"
						disabled={busy || !exhibition}
						onClick={async () => {
							if (!exhibition) return;
							if (
								!window.confirm(
									`Delete "${exhibition.name}" and all its rooms? The artworks themselves are kept.`,
								)
							) {
								return;
							}
							try {
								await curation.deleteExhibition();
								navigate({ to: "/explore", search: { view: "spaces" } });
							} catch {
								// Global handler toasts; navigate only on success and don't
								// let the rejection escape as unhandled.
							}
						}}
					>
						<Trash2 />
						Delete
					</Button>
				</div>
			</div>

			<VisitStatsStrip
				stats={statsQuery.data}
				isPublished={Boolean(exhibition?.isPublished)}
			/>

			{exhibition ? (
				<LintPanel report={curation.lint} loading={curation.lintLoading} />
			) : null}

			<section className="flex flex-col gap-4 rounded-2xl bg-card p-5">
				<h2 className="font-semibold text-lg tracking-[-0.02em]">Details</h2>
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="detail-name">Name</Label>
						<Input
							id="detail-name"
							value={details.name}
							onChange={(e) =>
								setDetails((d) => ({ ...d, name: e.target.value }))
							}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="detail-tagline">Tagline</Label>
						<Input
							id="detail-tagline"
							value={details.tagline}
							onChange={(e) =>
								setDetails((d) => ({ ...d, tagline: e.target.value }))
							}
						/>
					</div>
					<div className="flex flex-col gap-1.5 sm:col-span-2">
						<Label htmlFor="detail-description">Description</Label>
						<Textarea
							id="detail-description"
							rows={2}
							value={details.description}
							onChange={(e) =>
								setDetails((d) => ({ ...d, description: e.target.value }))
							}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="detail-kind">Shown in the lobby as</Label>
						<select
							id="detail-kind"
							value={details.kind}
							className="h-9 rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/20"
							onChange={(e) =>
								setDetails((d) => ({
									...d,
									kind: e.target.value as CuratedKind,
								}))
							}
						>
							{Object.entries(KIND_LABEL).map(([kind, label]) => (
								<option key={kind} value={kind}>
									{label}
								</option>
							))}
						</select>
					</div>
					<div className="flex items-end">
						<Button
							disabled={busy || details.name.trim().length === 0}
							onClick={() => void curation.saveDetails(details)}
						>
							Save details
						</Button>
					</div>
				</div>
			</section>

			<section className="flex flex-col gap-3">
				<div className="flex flex-col gap-1">
					<h2 className="font-semibold text-lg tracking-[-0.02em]">Theme</h2>
					<p className="text-muted-foreground text-sm">
						How the 3D rooms look when visitors walk through.
					</p>
				</div>
				{exhibition ? (
					<GalleryThemePanel
						exhibitionId={exhibition.id}
						theme={exhibition.theme}
						disabled={busy}
						onSave={curation.saveTheme}
					/>
				) : null}
			</section>

			<section className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex flex-wrap items-baseline gap-2">
						<h2 className="font-semibold text-lg tracking-[-0.02em]">
							{singleRoom ? (rooms[0]?.name ?? "Room") : "Rooms"}
						</h2>
						{singleRoom ? null : (
							<span className="text-muted-foreground text-sm">
								{rooms.length} rooms
							</span>
						)}
					</div>
					<div className="flex items-center gap-2">
						<Input
							value={newRoomName}
							placeholder="New room name"
							className="w-48"
							disabled={busy || !exhibition}
							onChange={(e) => setNewRoomName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && newRoomName.trim()) addRoom();
							}}
						/>
						<Button
							size="sm"
							disabled={busy || !exhibition || newRoomName.trim().length === 0}
							onClick={addRoom}
						>
							<Plus />
							Add room
						</Button>
					</div>
				</div>

				{floorPlan ? (
					<div className="flex flex-wrap items-start gap-5 rounded-2xl bg-card p-5">
						<FloorPlan
							world={floorPlan}
							maxWidth={320}
							maxHeight={220}
							showRoomNumbers={!singleRoom}
						/>
						<div className="flex min-w-48 flex-1 flex-col gap-1.5">
							<p className="font-medium text-sm">Floor plan</p>
							<p className="text-muted-foreground text-sm leading-relaxed">
								{singleRoom
									? "Each dot is a hung artwork. A room with more works than two walls can hold splits into wings automatically."
									: "Rooms are numbered in visiting order and connected by the gold doorways; each dot is a hung artwork. Rooms with more works than two walls can hold split into wings automatically."}
							</p>
							<p className="text-muted-foreground text-xs">
								{floorPlan.rooms.length}{" "}
								{floorPlan.rooms.length === 1 ? "room" : "rooms"} ·{" "}
								{floorPlan.paintings.length} artworks hung
							</p>
						</div>
					</div>
				) : null}
				{rooms.length === 0 ? (
					<p className="rounded-2xl border border-border border-dashed px-5 py-8 text-muted-foreground text-sm">
						No rooms yet. Add a room above, then hang artworks in it.
					</p>
				) : (
					<div className="flex flex-col gap-4">
						{rooms.map((room, index) => (
							<RoomCard
								key={room.id}
								room={room}
								index={index}
								total={rooms.length}
								analyzeRoom={analyzeRoom}
								curation={curation}
								busy={busy}
								coverArtworkId={exhibition?.coverArtworkId ?? null}
								implicitCoverId={implicitCoverId}
								isActiveTarget={activeRoomId === room.id}
								onAdd={() => focusPicker(room.id)}
							/>
						))}
					</div>
				)}
			</section>

			<div
				ref={pickerRef}
				className="flex flex-col gap-4 rounded-2xl bg-card p-5"
			>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="flex flex-col gap-1">
						<h2 className="font-semibold text-lg tracking-[-0.02em]">
							{activeRoom
								? singleRoom
									? "Add from your archive"
									: `Add to "${activeRoom.name}"`
								: "Your archive"}
						</h2>
						<p className="text-muted-foreground text-sm">
							{rooms.length === 0
								? "Add a room first, then pick artworks to hang in it."
								: singleRoom
									? "Tap to select. Adding an artwork publishes it so it can appear in the exhibition."
									: "Tap to select. Adding an artwork publishes it so it can appear in the exhibition. Each artwork hangs in one room."}
						</p>
					</div>
					<div className="flex items-center gap-2">
						{selected.size > 0 && activeRoom ? (
							<>
								<Button
									variant="ghost"
									size="sm"
									disabled={busy}
									onClick={() => setSelected(new Set())}
								>
									Clear
								</Button>
								<Button size="sm" disabled={busy} onClick={addSelected}>
									<Check />
									{singleRoom
										? `Add ${selected.size}`
										: `Add ${selected.size} to "${activeRoom.name}"`}
								</Button>
							</>
						) : (
							<Button variant="outline" size="sm" onClick={openImport}>
								<Upload />
								Import artworks
							</Button>
						)}
					</div>
				</div>
				{!curation.archiveLoaded ? null : available.length === 0 ? (
					<div className="flex flex-col items-start gap-4 rounded-2xl border border-border border-dashed px-5 py-8 text-muted-foreground text-sm">
						<span>
							{rooms.some((r) => r.members.length > 0)
								? "Every artwork in your archive is already hung in this exhibition."
								: "Your archive is empty. Import artworks to get started."}
						</span>
						<Button variant="outline" size="sm" onClick={openImport}>
							<Upload />
							Import artworks
						</Button>
					</div>
				) : visibleAvailable.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No archive artworks match “{search}”.
					</p>
				) : (
					<div className="grid grid-cols-[repeat(auto-fill,minmax(116px,1fr))] gap-3">
						{visibleAvailable.map((a) => (
							<ArchiveTile
								key={a.id}
								artwork={a}
								selected={selected.has(a.id)}
								disabled={!activeRoom}
								onToggle={() => toggleSelected(a.id)}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function RoomCard({
	room,
	index,
	total,
	analyzeRoom,
	curation,
	busy,
	coverArtworkId,
	implicitCoverId,
	isActiveTarget,
	onAdd,
}: {
	room: RoomView;
	index: number;
	total: number;
	analyzeRoom: (
		roomId: string,
		artworks: WallEditorArtwork[],
	) => RoomAnalysis | null;
	curation: ExhibitionCuration;
	busy: boolean;
	coverArtworkId: string | null;
	implicitCoverId: string | null;
	isActiveTarget: boolean;
	onAdd: () => void;
}) {
	const [draft, setDraft] = useState({
		name: room.name,
		description: room.description ?? "",
	});
	const [dragId, setDragId] = useState<string | null>(null);
	const [overId, setOverId] = useState<string | null>(null);
	const [view, setView] = useState<"order" | "walls">("order");
	const singleRoom = total === 1;
	const analyze = useCallback(
		(artworks: WallEditorArtwork[]) => analyzeRoom(room.id, artworks),
		[analyzeRoom, room.id],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reload form only when the room identity changes, not on every member refetch
	useEffect(() => {
		setDraft({ name: room.name, description: room.description ?? "" });
	}, [room.id]);

	const dirty =
		draft.name.trim() !== room.name ||
		draft.description.trim() !== (room.description ?? "");

	return (
		<div
			id={lintRoomAnchor(room.id)}
			className={cn(
				"flex flex-col gap-4 rounded-2xl bg-card p-5 transition-colors",
				isActiveTarget && !singleRoom && "bg-secondary",
			)}
		>
			<div className="flex flex-wrap items-center gap-2">
				{singleRoom ? null : (
					<span className="grid size-6 shrink-0 place-items-center rounded-full bg-background text-muted-foreground text-xs">
						{index + 1}
					</span>
				)}
				<Input
					value={draft.name}
					aria-label="Room name"
					className="min-w-0 flex-1"
					disabled={busy}
					onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
				/>
				<div className="flex items-center gap-1">
					{singleRoom ? null : (
						<>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Move room up"
								title="Move room up"
								disabled={busy || index === 0}
								onClick={() => curation.moveRoom(room.id, "up")}
							>
								<ChevronUp />
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Move room down"
								title="Move room down"
								disabled={busy || index === total - 1}
								onClick={() => curation.moveRoom(room.id, "down")}
							>
								<ChevronDown />
							</Button>
						</>
					)}
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Delete room"
						title="Delete room"
						className="hover:text-destructive"
						disabled={busy}
						onClick={() => {
							if (
								window.confirm(
									`Delete the room "${room.name}"? The artworks themselves are kept.`,
								)
							) {
								void curation.deleteRoom(room.id);
							}
						}}
					>
						<Trash2 />
					</Button>
				</div>
			</div>

			<div className="flex flex-wrap items-end gap-2">
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<Label
						htmlFor={`room-desc-${room.id}`}
						className="text-muted-foreground"
					>
						Room description
					</Label>
					<Input
						id={`room-desc-${room.id}`}
						value={draft.description}
						placeholder="Shown on the wall as visitors enter"
						disabled={busy}
						onChange={(e) =>
							setDraft((d) => ({ ...d, description: e.target.value }))
						}
					/>
				</div>
				<Button
					size="sm"
					variant="outline"
					disabled={busy || !dirty || draft.name.trim().length === 0}
					onClick={() =>
						void curation.renameRoom(room.id, {
							name: draft.name,
							description: draft.description,
						})
					}
				>
					Save room
				</Button>
			</div>

			{room.members.length > 0 ? (
				<div className="inline-flex items-center gap-0.5 self-start rounded-full bg-background p-1">
					<Button
						size="xs"
						variant={view === "order" ? "secondary" : "ghost"}
						onClick={() => setView("order")}
					>
						Order
					</Button>
					<Button
						size="xs"
						variant={view === "walls" ? "secondary" : "ghost"}
						onClick={() => setView("walls")}
					>
						Walls
					</Button>
				</div>
			) : null}

			{room.members.length === 0 ? (
				<p className="rounded-xl border border-border border-dashed px-4 py-6 text-muted-foreground text-sm">
					Empty room. Add artworks from your archive below.
				</p>
			) : view === "walls" ? (
				<WallPlacementEditor
					artworks={roomEditorArtworks(room)}
					analyze={analyze}
					disabled={busy}
					onChange={(artworkId, patch) =>
						curation.setPlacement(room.id, artworkId, patch)
					}
				/>
			) : (
				<ul className="flex flex-col gap-1">
					{room.members.map((a, i) => {
						const explicitCover = coverArtworkId === a.id;
						const isCover = coverArtworkId
							? explicitCover
							: a.id === implicitCoverId;
						const url = thumbUrl(a);
						return (
							<li
								key={a.id}
								id={lintArtworkAnchor(a.id)}
								className={cn(
									"flex items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-secondary/60",
									!busy && "cursor-grab",
									dragId === a.id && "opacity-50",
									overId === a.id &&
										dragId &&
										dragId !== a.id &&
										"bg-secondary text-foreground",
								)}
								draggable={!busy}
								onDragStart={(e) => {
									setDragId(a.id);
									e.dataTransfer.effectAllowed = "move";
									e.dataTransfer.setData("text/plain", a.id);
								}}
								onDragOver={(e) => {
									e.preventDefault();
									e.dataTransfer.dropEffect = "move";
									if (overId !== a.id) setOverId(a.id);
								}}
								onDrop={(e) => {
									e.preventDefault();
									if (dragId) curation.moveInRoom(room.id, dragId, a.id);
									setDragId(null);
									setOverId(null);
								}}
								onDragEnd={() => {
									setDragId(null);
									setOverId(null);
								}}
							>
								<GripVertical
									aria-hidden="true"
									className="size-4 shrink-0 text-muted-foreground"
								/>
								<span className="w-5 text-center text-muted-foreground text-xs">
									{i + 1}
								</span>
								{url ? (
									<img
										src={url}
										alt=""
										draggable={false}
										className="size-12 shrink-0 rounded-lg object-cover"
									/>
								) : (
									<div className="size-12 shrink-0 rounded-lg bg-secondary" />
								)}
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm">{a.title}</p>
									<p className="truncate text-muted-foreground text-xs">
										{a.artist ?? "Unknown artist"}
									</p>
								</div>
								<div className="flex items-center gap-1">
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label="Move up"
										title="Move up"
										disabled={busy || i === 0}
										onClick={() => {
											const prev = room.members[i - 1];
											if (prev) curation.moveInRoom(room.id, a.id, prev.id);
										}}
									>
										<ChevronUp />
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label="Move down"
										title="Move down"
										disabled={busy || i === room.members.length - 1}
										onClick={() => {
											const next = room.members[i + 1];
											if (next) curation.moveInRoom(room.id, a.id, next.id);
										}}
									>
										<ChevronDown />
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										aria-pressed={explicitCover}
										aria-label={
											explicitCover
												? "Current cover, click to reset"
												: "Set as cover"
										}
										title={
											explicitCover
												? "Current cover, click to reset"
												: "Set as cover"
										}
										className={cn(isCover && "text-amber-400")}
										disabled={busy}
										onClick={() =>
											void curation.setCover(explicitCover ? null : a.id)
										}
									>
										<Star fill={isCover ? "currentColor" : "none"} />
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label="Remove from room"
										title="Remove from room"
										className="hover:text-destructive"
										disabled={busy}
										onClick={() => curation.removeFromRoom(room.id, a.id)}
									>
										<X />
									</Button>
								</div>
							</li>
						);
					})}
				</ul>
			)}

			{room.warnings.length > 0 ? (
				<ul className="flex flex-col gap-1">
					{room.warnings.map((warning) => (
						<li
							key={`${warning.code}-${warning.artworkId ?? warning.wall ?? ""}`}
							className={cn(
								"flex items-start gap-2 text-sm",
								warning.level === "error"
									? "text-destructive"
									: "text-amber-500",
							)}
						>
							<TriangleAlert className="mt-0.5 size-4 shrink-0" />
							<span>{warning.message}</span>
						</li>
					))}
				</ul>
			) : null}

			<div>
				<Button variant="outline" size="sm" disabled={busy} onClick={onAdd}>
					<Plus />
					{singleRoom ? "Add artworks" : "Add artworks to this room"}
				</Button>
			</div>
		</div>
	);
}

function ArchiveTile({
	artwork,
	selected,
	disabled,
	onToggle,
}: {
	artwork: ArchiveArtwork;
	selected: boolean;
	disabled: boolean;
	onToggle: () => void;
}) {
	const url = thumbUrl(artwork);
	return (
		<button
			type="button"
			aria-pressed={selected}
			disabled={disabled}
			onClick={onToggle}
			title={disabled ? "Pick a room first" : `Select "${artwork.title}"`}
			className={cn(
				"group relative aspect-square overflow-hidden rounded-lg bg-secondary outline-none transition-all focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
				selected && "outline-2 outline-foreground outline-offset-2",
			)}
		>
			{url ? (
				<img
					src={url}
					alt={artwork.title}
					className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
				/>
			) : (
				<span className="grid size-full place-items-center p-2 text-center text-muted-foreground text-xs">
					{artwork.title}
				</span>
			)}
			<span
				className={cn(
					"absolute top-2 right-2 grid size-6 place-items-center rounded-full transition-opacity",
					selected
						? "bg-primary text-primary-foreground opacity-100"
						: "bg-black/55 text-white opacity-0 group-hover:opacity-100",
				)}
			>
				<Check className="size-3.5" />
			</span>
			<span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-2.5 pt-6 pb-2 text-left text-white text-xs opacity-0 transition-opacity group-hover:opacity-100">
				{artwork.title}
			</span>
		</button>
	);
}

import type {
	LayoutArtwork,
	RoomAnalysis,
	WallId,
} from "@aqt-gallery/gallery-layout";
import { Button } from "@aqt-gallery/ui/components/button";
import { Input } from "@aqt-gallery/ui/components/input";
import { Label } from "@aqt-gallery/ui/components/label";
import { cn } from "@aqt-gallery/ui/lib/utils";
import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type WallEditorArtwork = {
	id: string;
	title: string;
	thumbnailUrl: string | null;
	dimensions: string | null;
	imageWidth: number | null;
	imageHeight: number | null;
	wall: WallId | null;
	wallOffset: number | null;
	scale: number | null;
};

export type PlacementPatch = {
	wall?: WallId | null;
	wallOffset?: number | null;
	scale?: number | null;
};

/** Only the size-relevant fields; the renderer's layout math ignores the rest. */
export function toLayoutArtwork(a: WallEditorArtwork): LayoutArtwork {
	return {
		dimensions: a.dimensions,
		imageWidth: a.imageWidth,
		imageHeight: a.imageHeight,
		wall: a.wall,
		wallOffset: a.wallOffset,
		scale: a.scale,
	};
}

const WALLS: WallId[] = ["north", "south", "east", "west"];
const WALL_LABEL: Record<WallId, string> = {
	north: "North",
	south: "South",
	east: "East",
	west: "West",
};
const OFFSET_STEP = 0.02;
/** Corner padding (percent of the board) so chips on adjacent walls never stack
 * in the same corner. */
const CORNER_PAD = 9;

function clamp01(v: number): number {
	return Math.min(1, Math.max(0, v));
}

/** The renderer parameterizes east/west walls south→north (stored offset 0 = the
 * south end), but this editor is screen-space with north at the top of the board
 * (offset 0 = the north end). Flip side-wall offsets at the store boundary so the
 * board stays WYSIWYG with itself while matching the renderer. The flip is its
 * own inverse, so the same conversion applies on read and on write. */
function convertSideOffset(wall: WallId, offset: number): number {
	return wall === "east" || wall === "west" ? 1 - offset : offset;
}

/** The wall closest to a point in the board's 0..1 space, and the normalized
 * offset along that wall. Routing the whole board to its nearest edge makes a
 * chip easy to drop without hitting a thin strip exactly. */
function nearestWall(rx: number, ry: number): { wall: WallId; offset: number } {
	const dist: Record<WallId, number> = {
		north: ry,
		south: 1 - ry,
		west: rx,
		east: 1 - rx,
	};
	let wall: WallId = "north";
	for (const w of WALLS) {
		if (dist[w] < dist[wall]) wall = w;
	}
	const offset = wall === "north" || wall === "south" ? rx : ry;
	return { wall, offset: clamp01(offset) };
}

/** Absolute position of a chip on the board for a given wall + offset. Along-wall
 * offset maps to a percentage inset from the corners; the cross-wall axis is a
 * fixed distance from the edge. */
function chipStyle(wall: WallId, offset: number): React.CSSProperties {
	const along = `${CORNER_PAD + clamp01(offset) * (100 - 2 * CORNER_PAD)}%`;
	const edge = "22px";
	switch (wall) {
		case "north":
			return { left: along, top: edge };
		case "south":
			return { left: along, bottom: edge };
		case "west":
			return { top: along, left: edge };
		case "east":
			return { top: along, right: edge };
	}
}

type DragState = {
	id: string;
	wall: WallId;
	offset: number;
	/** Set once the pointer actually moves, so a plain click (select) doesn't
	 * commit a placement — which would hang an auto work on the default wall. */
	moved: boolean;
};

export function WallPlacementEditor({
	artworks,
	analyze,
	disabled,
	onChange,
}: {
	artworks: WallEditorArtwork[];
	/** This room's wall loads for a candidate hang, from the museum-wide floor
	 * plan (analyzeWorld). Door walls depend on the neighbouring rooms, so the
	 * parent owns the plan; it is re-run on every drag move so the overflow
	 * warning tracks the pointer. */
	analyze: (artworks: WallEditorArtwork[]) => RoomAnalysis | null;
	disabled: boolean;
	onChange: (artworkId: string, patch: PlacementPatch) => void;
}) {
	const boardRef = useRef<HTMLDivElement | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [drag, setDrag] = useState<DragState | null>(null);

	// Everything below the store boundary works in editor (screen-space) offsets.
	const editorArtworks = useMemo(
		() =>
			artworks.map((a) =>
				a.wall != null && a.wallOffset != null
					? { ...a, wallOffset: convertSideOffset(a.wall, a.wallOffset) }
					: a,
			),
		[artworks],
	);

	// Convert back to the stored (renderer) axis before persisting. Nudges and
	// arrows omit the wall, so fall back to the artwork's current wall.
	const commit = useCallback(
		(id: string, patch: PlacementPatch) => {
			if (patch.wallOffset == null) {
				onChange(id, patch);
				return;
			}
			const wall =
				patch.wall ?? artworks.find((a) => a.id === id)?.wall ?? null;
			onChange(
				id,
				wall == null
					? patch
					: { ...patch, wallOffset: convertSideOffset(wall, patch.wallOffset) },
			);
		},
		[artworks, onChange],
	);

	// Merge an in-flight drag over the persisted placements so the board tracks
	// the pointer without a server round trip per move.
	const effective = useMemo(
		() =>
			editorArtworks.map((a) =>
				drag?.moved && drag.id === a.id
					? { ...a, wall: drag.wall, wallOffset: drag.offset }
					: a,
			),
		[editorArtworks, drag],
	);

	const analysis = useMemo(() => analyze(effective), [analyze, effective]);

	// The renderer only auto-splits (and so rescues from overflow) rooms with no
	// curated placement; once a wall is pinned it lays works out as-is. Mirror
	// lint and only warn for curated rooms, so a purely auto room isn't flagged.
	const overflowWalls = analysis?.curated
		? analysis.walls.filter((w) => w.overflow)
		: [];
	const overflowByWall = new Map(
		overflowWalls.map((w) => [w.wall, true as const]),
	);
	const doorWalls = new Set(
		analysis?.walls.filter((w) => w.hasDoor).map((w) => w.wall) ?? [],
	);

	const placed = effective.filter((a) => a.wall != null);
	const unplaced = effective.filter((a) => a.wall == null);
	const selected = editorArtworks.find((a) => a.id === selectedId) ?? null;

	// Drop the selection if its artwork leaves the room.
	useEffect(() => {
		if (selectedId && !artworks.some((a) => a.id === selectedId)) {
			setSelectedId(null);
		}
	}, [artworks, selectedId]);

	// Window-level move/up while dragging: routes the pointer to a wall and
	// commits on release.
	useEffect(() => {
		if (!drag) return;
		const onMove = (e: PointerEvent) => {
			const board = boardRef.current;
			if (!board) return;
			const rect = board.getBoundingClientRect();
			const rx = clamp01((e.clientX - rect.left) / rect.width);
			const ry = clamp01((e.clientY - rect.top) / rect.height);
			const { wall, offset } = nearestWall(rx, ry);
			setDrag((prev) => (prev ? { ...prev, wall, offset, moved: true } : prev));
		};
		const onUp = () => {
			setDrag((prev) => {
				if (prev?.moved) {
					commit(prev.id, { wall: prev.wall, wallOffset: prev.offset });
				}
				return null;
			});
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
	}, [drag, commit]);

	const startDrag = (a: WallEditorArtwork, e: React.PointerEvent) => {
		if (disabled) return;
		e.preventDefault();
		setSelectedId(a.id);
		setDrag({
			id: a.id,
			wall: a.wall ?? "north",
			offset: a.wallOffset ?? 0.5,
			moved: false,
		});
	};

	const nudgeOffset = (a: WallEditorArtwork, delta: number) => {
		if (a.wall == null) return;
		commit(a.id, { wallOffset: clamp01((a.wallOffset ?? 0.5) + delta) });
	};

	return (
		<div className="flex flex-col gap-3">
			{overflowWalls.length > 0 ? (
				<div className="flex items-start gap-2 rounded-xl bg-destructive/10 px-4 py-3 text-destructive text-sm">
					<AlertTriangle className="mt-0.5 size-4 shrink-0" />
					<div className="flex flex-col gap-1">
						{overflowWalls.map((w) => (
							<span key={w.wall}>
								<strong>{WALL_LABEL[w.wall]} wall</strong> is over capacity:{" "}
								{w.count} works need ~{w.required.toFixed(1)}m on a ~
								{w.available.toFixed(1)}m wall, so they will overlap.
							</span>
						))}
					</div>
				</div>
			) : null}

			<div
				ref={boardRef}
				className="relative mx-auto aspect-[4/3] w-full max-w-[560px] select-none overflow-hidden rounded-xl bg-background"
			>
				{WALLS.map((wall) => (
					<WallBand
						key={wall}
						wall={wall}
						overflow={overflowByWall.get(wall) ?? false}
						hasDoor={doorWalls.has(wall)}
						active={drag?.wall === wall}
					/>
				))}
				<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center text-muted-foreground text-xs">
					<p>Floor</p>
					{analysis ? (
						<p className="mt-1">
							{analysis.width.toFixed(1)}m × {analysis.depth.toFixed(1)}m
						</p>
					) : null}
				</div>

				{placed.map((a) => (
					<Chip
						key={a.id}
						artwork={a}
						style={chipStyle(a.wall as WallId, a.wallOffset ?? 0.5)}
						selected={selectedId === a.id}
						dragging={drag?.id === a.id}
						disabled={disabled}
						onSelect={() => setSelectedId(a.id)}
						onPointerDown={(e) => startDrag(a, e)}
						onOffsetKey={(delta) => nudgeOffset(a, delta)}
					/>
				))}
			</div>

			{unplaced.length > 0 ? (
				<div className="flex flex-col gap-1.5">
					<p className="text-muted-foreground text-sm">
						Auto-placed ({unplaced.length}). Drag onto a wall to hang precisely.
					</p>
					<div className="flex flex-wrap gap-2">
						{unplaced.map((a) => (
							<Chip
								key={a.id}
								artwork={a}
								selected={selectedId === a.id}
								dragging={drag?.id === a.id}
								disabled={disabled}
								onSelect={() => setSelectedId(a.id)}
								onPointerDown={(e) => startDrag(a, e)}
								onOffsetKey={() => {}}
							/>
						))}
					</div>
				</div>
			) : null}

			{selected ? (
				<PlacementControls
					artwork={selected}
					disabled={disabled}
					onChange={commit}
				/>
			) : (
				<p className="text-muted-foreground text-sm">
					Select an artwork to move it to a wall, nudge its position, or resize
					it.
				</p>
			)}
		</div>
	);
}

function WallBand({
	wall,
	overflow,
	hasDoor,
	active,
}: {
	wall: WallId;
	overflow: boolean;
	hasDoor: boolean;
	active: boolean;
}) {
	const horizontal = wall === "north" || wall === "south";
	const base =
		"absolute flex items-center justify-center bg-secondary text-muted-foreground text-xs transition-colors";
	const pos =
		wall === "north"
			? "inset-x-0 top-0 h-10"
			: wall === "south"
				? "inset-x-0 bottom-0 h-10"
				: wall === "west"
					? "inset-y-0 left-0 w-10"
					: "inset-y-0 right-0 w-10";
	return (
		<div
			className={cn(
				base,
				pos,
				active && "bg-accent",
				overflow && "bg-destructive/15 text-destructive",
			)}
		>
			<span className={cn(!horizontal && "[writing-mode:vertical-rl]")}>
				{WALL_LABEL[wall]}
				{hasDoor ? " · door" : ""}
			</span>
		</div>
	);
}

function Chip({
	artwork,
	style,
	selected,
	dragging,
	disabled,
	onSelect,
	onPointerDown,
	onOffsetKey,
}: {
	artwork: WallEditorArtwork;
	style?: React.CSSProperties;
	selected: boolean;
	dragging: boolean;
	disabled: boolean;
	onSelect: () => void;
	onPointerDown: (e: React.PointerEvent) => void;
	onOffsetKey: (delta: number) => void;
}) {
	const positioned = style !== undefined;
	return (
		<button
			type="button"
			title={artwork.title}
			aria-label={artwork.title}
			aria-pressed={selected}
			disabled={disabled}
			style={
				positioned
					? { ...style, transform: "translate(-50%, -50%)" }
					: undefined
			}
			className={cn(
				"grid size-11 shrink-0 touch-none place-items-center overflow-hidden rounded-lg bg-background outline-none",
				positioned && "absolute z-10",
				!disabled && "cursor-grab active:cursor-grabbing",
				selected && "outline-2 outline-foreground -outline-offset-2",
				dragging && "opacity-70 outline-2 outline-ring -outline-offset-2",
			)}
			onPointerDown={onPointerDown}
			onClick={onSelect}
			onKeyDown={(e) => {
				if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
					e.preventDefault();
					onOffsetKey(-OFFSET_STEP);
				} else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
					e.preventDefault();
					onOffsetKey(OFFSET_STEP);
				}
			}}
		>
			{artwork.thumbnailUrl ? (
				<img
					src={artwork.thumbnailUrl}
					alt=""
					draggable={false}
					className="size-full object-cover"
				/>
			) : (
				<span className="px-1 text-center text-[10px] text-muted-foreground leading-tight">
					{artwork.title.slice(0, 12)}
				</span>
			)}
		</button>
	);
}

function PlacementControls({
	artwork,
	disabled,
	onChange,
}: {
	artwork: WallEditorArtwork;
	disabled: boolean;
	onChange: (artworkId: string, patch: PlacementPatch) => void;
}) {
	// Scale is committed on blur/Enter, not per keystroke, so a drag-heavy edit
	// session doesn't fire a mutation on every digit.
	const [scaleDraft, setScaleDraft] = useState(
		artwork.scale != null ? String(artwork.scale) : "",
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: resync the field only when a different artwork (or its saved scale) loads
	useEffect(() => {
		setScaleDraft(artwork.scale != null ? String(artwork.scale) : "");
	}, [artwork.id, artwork.scale]);

	const commitScale = () => {
		const trimmed = scaleDraft.trim();
		if (trimmed === "") {
			onChange(artwork.id, { scale: null });
			return;
		}
		const value = Number.parseFloat(trimmed);
		if (!Number.isFinite(value)) return;
		onChange(artwork.id, { scale: Math.min(5, Math.max(0.1, value)) });
	};

	const offsetPct = Math.round((artwork.wallOffset ?? 0.5) * 100);

	return (
		<div className="flex flex-col gap-4 rounded-xl bg-background p-4">
			<div className="flex items-center gap-2">
				{artwork.thumbnailUrl ? (
					<img
						src={artwork.thumbnailUrl}
						alt=""
						className="size-10 shrink-0 rounded-lg object-cover"
					/>
				) : (
					<div className="size-10 shrink-0 rounded-lg bg-secondary" />
				)}
				<p className="min-w-0 flex-1 truncate text-sm">{artwork.title}</p>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label className="text-muted-foreground">Wall</Label>
				<div className="flex flex-wrap gap-1">
					{WALLS.map((wall) => (
						<Button
							key={wall}
							size="sm"
							variant={artwork.wall === wall ? "secondary" : "outline"}
							disabled={disabled}
							onClick={() =>
								onChange(artwork.id, {
									wall,
									wallOffset: artwork.wallOffset ?? 0.5,
								})
							}
						>
							{WALL_LABEL[wall]}
						</Button>
					))}
					<Button
						size="sm"
						variant={artwork.wall == null ? "secondary" : "ghost"}
						disabled={disabled}
						onClick={() => onChange(artwork.id, { wall: null })}
					>
						Auto
					</Button>
				</div>
			</div>

			<div className="flex flex-wrap items-end gap-4">
				<div className="flex flex-col gap-1.5">
					<Label className="text-muted-foreground">
						Position along wall ({offsetPct}%)
					</Label>
					<div className="flex items-center gap-1">
						<Button
							variant="outline"
							size="icon-sm"
							aria-label="Move toward start of wall"
							disabled={disabled || artwork.wall == null}
							onClick={() =>
								onChange(artwork.id, {
									wallOffset: clamp01(
										(artwork.wallOffset ?? 0.5) - OFFSET_STEP,
									),
								})
							}
						>
							<ChevronLeft />
						</Button>
						<Button
							variant="outline"
							size="icon-sm"
							aria-label="Move toward end of wall"
							disabled={disabled || artwork.wall == null}
							onClick={() =>
								onChange(artwork.id, {
									wallOffset: clamp01(
										(artwork.wallOffset ?? 0.5) + OFFSET_STEP,
									),
								})
							}
						>
							<ChevronRight />
						</Button>
					</div>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={`scale-${artwork.id}`}
						className="text-muted-foreground"
					>
						Scale
					</Label>
					<Input
						id={`scale-${artwork.id}`}
						type="number"
						min={0.1}
						max={5}
						step={0.1}
						placeholder="1.0"
						className="w-24"
						disabled={disabled}
						value={scaleDraft}
						onChange={(e) => setScaleDraft(e.target.value)}
						onBlur={commitScale}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								commitScale();
							}
						}}
					/>
				</div>
			</div>
		</div>
	);
}

/**
 * Pure pre-publish validation for a gallery (one room) or museum (many
 * rooms). The 3D renderer degrades silently on missing data — a hung work
 * that is deleted/unpublished just vanishes, a dimensionless work gets a
 * guessed aspect ratio, an over-packed wall overlaps its neighbours. This
 * module turns those into explicit errors/warnings the curator (or an agent)
 * can act on before publishing.
 *
 * No DB access here: museum.ts loads the rows and hands this a normalized
 * view. Wall-capacity math reuses @aqt-gallery/gallery-layout so the warnings
 * match what the renderer actually does.
 */
import {
	analyzeWorld,
	parsePhysicalSize,
	type WallId,
	type WorldArtworkInput,
} from "@aqt-gallery/gallery-layout";

export type LintLevel = "error" | "warning" | "info";

/** How far an image's aspect may drift from the catalogued dimensions before
 * it is reported. Museum scans routinely differ by a few percent (frame lips,
 * uneven panels); a preview crop or a framed photo is far outside this. */
const ASPECT_TOLERANCE = 1.15;

export type LintFinding = {
	level: LintLevel;
	/** Stable machine code so an agent can branch on the issue type. */
	code: string;
	message: string;
	roomId?: string;
	roomName?: string;
	artworkId?: string;
	artworkTitle?: string;
	wall?: WallId;
};

/** The minimal artwork view the linter needs. `null` member.artwork marks a
 * hung id that no longer resolves to a row (purged). */
export type LintArtwork = {
	id: string;
	title: string;
	dimensions: string | null;
	story: string | null;
	artistId: string | null;
	artistName: string | null;
	hasImage: boolean;
	imageWidth: number | null;
	imageHeight: number | null;
	isPublished: boolean;
	isDeleted: boolean;
};

export type LintMember = {
	artworkId: string;
	artwork: LintArtwork | null;
	wall: WallId | null;
	wallOffset: number | null;
	scale: number | null;
};

export type LintRoomInput = {
	id: string;
	name: string;
	layout: { width?: number; depth?: number; height?: number } | null;
	members: LintMember[];
};

export type LintInput = {
	kind: "gallery" | "museum";
	name: string;
	rooms: LintRoomInput[];
};

export type LintReport = {
	ok: boolean;
	errorCount: number;
	warningCount: number;
	infoCount: number;
	roomCount: number;
	artworkCount: number;
	findings: LintFinding[];
};

/** A member appears on a wall only if its row exists, is live, and is
 * published — exactly the filter loadArtworksWithArtists applies. A missing
 * image still renders (a placeholder), so it does not gate layout. */
function isRenderable(member: LintMember): member is LintMember & {
	artwork: LintArtwork;
} {
	return Boolean(
		member.artwork && !member.artwork.isDeleted && member.artwork.isPublished,
	);
}

function toLayoutArtwork(
	member: LintMember & { artwork: LintArtwork },
): WorldArtworkInput {
	return {
		id: member.artwork.id,
		dimensions: member.artwork.dimensions,
		imageWidth: member.artwork.imageWidth,
		imageHeight: member.artwork.imageHeight,
		wall: member.wall,
		wallOffset: member.wallOffset,
		scale: member.scale,
	};
}

const WALL_LABEL: Record<WallId, string> = {
	north: "north",
	south: "south",
	east: "east",
	west: "west",
};

export function runLint(input: LintInput): LintReport {
	const findings: LintFinding[] = [];
	const add = (f: LintFinding) => findings.push(f);

	// Distinct renderable artworks — an artwork hung in multiple museum rooms
	// must count once, not once per placement.
	const renderedArtworkIds = new Set<string>();

	// ── Per-member integrity (errors a curator can't see from the studio) ──────
	for (const room of input.rooms) {
		for (const member of room.members) {
			const ctx = {
				roomId: room.id,
				roomName: room.name,
				artworkId: member.artworkId,
			};
			if (!member.artwork) {
				add({
					...ctx,
					level: "error",
					code: "member_missing",
					message: `A hung artwork (${member.artworkId}) no longer exists and won't appear.`,
				});
				continue;
			}
			const ctxT = { ...ctx, artworkTitle: member.artwork.title };
			if (member.artwork.isDeleted) {
				add({
					...ctxT,
					level: "error",
					code: "member_deleted",
					message: `"${member.artwork.title}" is deleted; it won't appear in the 3D room.`,
				});
				continue;
			}
			if (!member.artwork.isPublished) {
				add({
					...ctxT,
					level: "error",
					code: "member_unpublished",
					message: `"${member.artwork.title}" is not published; it won't appear in the 3D room.`,
				});
				continue;
			}
			renderedArtworkIds.add(member.artwork.id);
			if (!member.artwork.hasImage) {
				add({
					...ctxT,
					level: "warning",
					code: "member_no_image",
					message: `"${member.artwork.title}" has no image; the wall shows an "image unavailable" placeholder.`,
				});
			}
		}
	}

	// ── Empty rooms / nothing to render ────────────────────────────────────────
	// Filter each room's renderable members once and reuse it for both the
	// empty-room warning and the renderable set, so the predicate can't drift
	// between the two and the work isn't repeated.
	const roomsWithRenderable = input.rooms.map((room) => ({
		room,
		members: room.members.filter(isRenderable),
	}));
	const renderableRooms = roomsWithRenderable.filter(
		(entry) => entry.members.length > 0,
	);

	if (input.kind === "museum") {
		for (const entry of roomsWithRenderable) {
			if (entry.members.length === 0) {
				add({
					level: "warning",
					code: "empty_room",
					roomId: entry.room.id,
					roomName: entry.room.name,
					message: `Room "${entry.room.name}" has no displayable artworks; it is skipped in the walk.`,
				});
			}
		}
	}

	if (renderableRooms.length === 0) {
		add({
			level: "error",
			code: "nothing_to_render",
			message:
				input.kind === "gallery"
					? "This gallery has no displayable artworks — visitors see bare walls."
					: "This museum has no displayable artworks in any room — visitors see bare walls.",
		});
	}

	// ── Aggregated content gaps across all displayable works ───────────────────
	const renderable = renderableRooms.flatMap((entry) => entry.members);
	let noDimensions = 0;
	let noStory = 0;
	let noAttribution = 0;
	for (const member of renderable) {
		const a = member.artwork;
		if (a.dimensions?.trim()) {
			const physical = parsePhysicalSize(a.dimensions);
			if (!physical) {
				add({
					level: "warning",
					code: "dimensions_unparseable",
					artworkId: a.id,
					artworkTitle: a.title,
					message: `"${a.title}" dimensions "${a.dimensions}" have no "<h> × <w> cm" figure; the 3D size falls back to the image aspect.`,
				});
			} else if (a.imageWidth && a.imageHeight) {
				const ratio =
					a.imageWidth / a.imageHeight / (physical.width / physical.height);
				if (ratio > ASPECT_TOLERANCE || ratio < 1 / ASPECT_TOLERANCE) {
					add({
						level: "warning",
						code: "aspect_mismatch",
						artworkId: a.id,
						artworkTitle: a.title,
						message: `"${a.title}" image is ${a.imageWidth}×${a.imageHeight} px but its dimensions "${a.dimensions}" describe a different shape; the image is probably a detail crop or includes the frame. The canvas keeps the image's shape and only its size is taken from the dimensions.`,
					});
				}
			}
		} else {
			noDimensions += 1;
		}
		if (!a.story?.trim()) noStory += 1;
		if (!a.artistId && !a.artistName?.trim()) noAttribution += 1;
	}

	const total = renderable.length;
	if (noDimensions > 0) {
		add({
			level: "warning",
			code: "missing_dimensions",
			message: `${noDimensions} of ${total} displayable artworks have no real-world dimensions; their 3D size is approximated from the image aspect.`,
		});
	}
	if (noStory > 0) {
		add({
			level: "warning",
			code: "missing_story",
			message: `${noStory} of ${total} displayable artworks have no story; their inspect panel shows no narrative.`,
		});
	}
	if (noAttribution > 0) {
		add({
			level: "info",
			code: "missing_artist",
			message: `${noAttribution} of ${total} displayable artworks have no artist attribution (neither a linked artist nor a name).`,
		});
	}

	// ── Wall overflow (only where the renderer's auto-splitter is bypassed) ─────
	// analyzeWorld runs the renderer's own floor plan, so door walls and shared
	// cell sizes are exactly what visitors get. Auto rooms split into wings
	// instead of overflowing, so only curated rooms can be flagged; wing
	// analyses report against their source room.
	const roomBySource = new Map(
		renderableRooms.map((entry) => [entry.room.id, entry.room]),
	);
	const analyses = analyzeWorld({
		rooms: renderableRooms.map((entry) => ({
			id: entry.room.id,
			name: entry.room.name,
			description: null,
			layout: entry.room.layout,
			artworks: entry.members.map(toLayoutArtwork),
		})),
	});
	for (const analysis of analyses) {
		if (!analysis.curated) continue;
		const room = roomBySource.get(analysis.sourceId);
		if (!room) continue;
		for (const wall of analysis.walls) {
			if (!wall.overflow) continue;
			add({
				level: "warning",
				code: "wall_overflow",
				roomId: room.id,
				roomName: room.name,
				wall: wall.wall,
				message: `The ${WALL_LABEL[wall.wall]} wall of "${room.name}" is over capacity: ${wall.count} works need ~${wall.required.toFixed(1)}m on a ~${wall.available.toFixed(1)}m wall, so they will overlap. Spread them across more walls or enlarge the room.`,
			});
		}
	}

	const errorCount = findings.filter((f) => f.level === "error").length;
	const warningCount = findings.filter((f) => f.level === "warning").length;
	const infoCount = findings.filter((f) => f.level === "info").length;

	return {
		ok: errorCount === 0,
		errorCount,
		warningCount,
		infoCount,
		roomCount: input.rooms.length,
		artworkCount: renderedArtworkIds.size,
		findings,
	};
}

/**
 * Floor-plan graph and full 3D world layout, shared by the renderer
 * (apps/web), the pre-publish linter (apps/server) and the studio's wall
 * editor / floor-plan preview. Pure functions over plain numbers: no three.js,
 * no DB types.
 *
 * Coordinate system: x runs east (+) / west (-), z runs north (+) / south (-),
 * y is up. The entrance room sits at the south end (row 0, z = 0) and the
 * visitor spawns facing north (+z). Camera yaw θ has forward = (−sin θ, −cos θ),
 * so facing +z is θ = π.
 *
 * Rooms tile a rectangular grid and the curated visiting order snakes through
 * it: row 0 west→east, row 1 east→west, and so on. Consecutive rooms share a
 * wall with a centred doorway, so the room order is also a walkable path.
 * Museums with up to three rooms stay a single column (a classic corridor).
 */
import {
	clamp,
	DOOR_HEIGHT,
	DOOR_WIDTH,
	displaySize,
	EYE_HEIGHT,
	HANG_HEIGHT,
	type LayoutArtwork,
	MAX_ROOM_DEPTH,
	MIN_ROOM_DEPTH,
	PLAYER_RADIUS,
	slotWidth,
	WALL_END_MARGIN,
	WALL_THICKNESS,
	type WallId,
} from "./core";

export const MIN_AUTO_ROOM_WIDTH = 13;
export const MAX_AUTO_ROOM_WIDTH = 24;
/** Added to a wall's load when sizing an auto room: both end margins plus
 * breathing room. */
const ROOM_SIZE_SLACK = 2 * WALL_END_MARGIN + 0.8;
/** Most one door-free wall of an auto wing may carry. A wing's unassigned works
 * land on whichever two walls stay door-free, so the budget is the tighter
 * (width-bound) figure and a full wing still sizes with slack to spare. */
export const MAX_AUTO_WALL_SPAN = MAX_AUTO_ROOM_WIDTH - ROOM_SIZE_SLACK;
/** Gap kept between a doorway edge and the nearest painting slot. */
export const DOOR_CLEARANCE = 0.8;

export type WorldArtworkInput = LayoutArtwork & { id: string };

export type WorldRoomInput = {
	id: string;
	name: string;
	description: string | null;
	layout: { width?: number; depth?: number; height?: number } | null;
	/** Curated hang order (placement position order). */
	artworks: WorldArtworkInput[];
};

export type WorldInput = { rooms: WorldRoomInput[] };

export type Box = {
	position: [number, number, number];
	size: [number, number, number];
};

export type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

export type Door = {
	/** Wall of this room the opening sits in. */
	wall: WallId;
	/** Opening centre in world coordinates (floor level). */
	x: number;
	z: number;
	width: number;
	height: number;
	/** Index of the room on the other side. */
	toRoom: number;
};

export type RoomLayout3D = Rect & {
	index: number;
	id: string;
	/** Source room id before wing splitting (equals `id` for unsplit rooms). */
	sourceId: string;
	name: string;
	description: string | null;
	width: number;
	depth: number;
	height: number;
	centerX: number;
	centerZ: number;
	col: number;
	row: number;
	doors: Door[];
};

export type PaintingLayout = {
	artworkId: string;
	roomIndex: number;
	wall: WallId;
	/** Centre of the canvas face (world). */
	position: [number, number, number];
	/** Rotation about y so the painting faces into the room. */
	rotationY: number;
	/** Inward normal of the wall the painting hangs on. */
	normal: [number, number, number];
	/** Canvas size in metres. */
	width: number;
	height: number;
};

export type Doorway = {
	x: number;
	z: number;
	/** Axis the wall runs along: "x" for north/south walls, "z" for east/west. */
	axis: "x" | "z";
	width: number;
	height: number;
	rooms: [number, number];
};

export type WorldLayout = {
	bounds: Rect;
	maxHeight: number;
	rooms: RoomLayout3D[];
	/** Every wall segment (including lintels above doors). */
	walls: Box[];
	/** Walls the player collides with (lintels excluded). */
	colliders: Box[];
	/** Colliders relevant to a player standing in room i: its own walls plus
	 * those of every room reachable through one of its doors. */
	collidersByRoom: Box[][];
	paintings: PaintingLayout[];
	/** Painting indices grouped by room index. */
	paintingsByRoom: number[][];
	doorways: Doorway[];
	spawn: [number, number, number];
	spawnYaw: number;
	/** Indices into `paintings` in curated visiting order (rooms in order,
	 * placements in position order). */
	tourOrder: number[];
};

export type WallLoad = {
	wall: WallId;
	count: number;
	/** Metres the works assigned here need along the wall (incl. margins). */
	required: number;
	/** Usable metres on the wall after end margins and any door opening. */
	available: number;
	overflow: boolean;
	hasDoor: boolean;
};

export type RoomAnalysis = {
	/** Generated room id (wings get a suffix) and the source room it came from. */
	roomId: string;
	sourceId: string;
	roomName: string;
	width: number;
	depth: number;
	height: number;
	/** The curator pinned the size or any wall, so the auto wing-splitter does
	 * not rescue an overflow. */
	curated: boolean;
	walls: WallLoad[];
};

export type Vec3Like = { x: number; y: number; z: number };

type GeneratedRoom = WorldRoomInput & { sourceId: string };

type Slot = {
	artwork: WorldArtworkInput;
	width: number;
	height: number;
	slot: number;
};

type Span = { from: number; to: number };

type GridPos = { row: number; col: number };

type RoomPlan = {
	room: GeneratedRoom;
	pos: GridPos;
	doorWalls: WallId[];
	curated: boolean;
	width: number;
	depth: number;
	height: number;
	wallSlots: Record<WallId, Slot[]>;
};

type PlannedWorld = {
	plans: RoomPlan[];
	rooms: RoomLayout3D[];
	cols: number;
	rows: number;
	/** Column boundaries (cols + 1) and row boundaries (rows + 1). */
	colX: number[];
	rowZ: number[];
};

const WALL_ORDER: readonly WallId[] = ["east", "west", "north", "south"];
const WING_NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

const sum = (xs: readonly number[]) => xs.reduce((acc, x) => acc + x, 0);

function isCurated(room: WorldRoomInput): boolean {
	return room.layout != null || room.artworks.some((a) => a.wall != null);
}

function splitToCapacity(room: WorldRoomInput): GeneratedRoom[] {
	const whole: GeneratedRoom = { ...room, sourceId: room.id };
	if (isCurated(room)) return [whole];

	const chunks: WorldArtworkInput[][] = [];
	let current: WorldArtworkInput[] = [];
	const load: [number, number] = [0, 0];
	for (const artwork of room.artworks) {
		const width = slotWidth(displaySize(artwork).width);
		let target: 0 | 1 = current.length % 2 === 0 ? 0 : 1;
		if (current.length > 0 && load[target] + width > MAX_AUTO_WALL_SPAN) {
			chunks.push(current);
			current = [];
			load[0] = 0;
			load[1] = 0;
			target = 0;
		}
		load[target] += width;
		current.push(artwork);
	}
	if (current.length > 0) chunks.push(current);
	if (chunks.length <= 1) return [whole];

	return chunks.map((artworks, i) =>
		i === 0
			? { ...whole, artworks }
			: {
					...whole,
					id: `${room.id}__wing-${i + 1}`,
					name: `${room.name} · ${WING_NUMERALS[i] ?? String(i + 1)}`,
					description: null,
					artworks,
				},
	);
}

function gridColumns(roomCount: number): number {
	return roomCount <= 3 ? 1 : Math.ceil(Math.sqrt(roomCount));
}

function gridPosition(index: number, cols: number): GridPos {
	const row = Math.floor(index / cols);
	const col = row % 2 === 0 ? index % cols : cols - 1 - (index % cols);
	return { row, col };
}

/** Walls the door between two consecutive rooms sits in: [wall of the first,
 * wall of the second]. */
function doorWallsBetween(a: GridPos, b: GridPos): [WallId, WallId] {
	if (a.row !== b.row) return ["north", "south"];
	return a.col < b.col ? ["east", "west"] : ["west", "east"];
}

function doorWallsOf(index: number, roomCount: number, cols: number): WallId[] {
	const here = gridPosition(index, cols);
	const walls: WallId[] = [];
	if (index > 0) {
		walls.push(doorWallsBetween(gridPosition(index - 1, cols), here)[1]);
	}
	if (index < roomCount - 1) {
		walls.push(doorWallsBetween(here, gridPosition(index + 1, cols))[0]);
	}
	return walls;
}

function planRoom(
	room: GeneratedRoom,
	pos: GridPos,
	doorWalls: WallId[],
): RoomPlan {
	const wallSlots: Record<WallId, Slot[]> = {
		north: [],
		south: [],
		east: [],
		west: [],
	};
	const freeWalls = WALL_ORDER.filter((w) => !doorWalls.includes(w));
	let autoIndex = 0;
	for (const artwork of room.artworks) {
		const size = displaySize(artwork);
		const slot: Slot = { artwork, ...size, slot: slotWidth(size.width) };
		const wall =
			artwork.wall ?? freeWalls[autoIndex++ % freeWalls.length] ?? "east";
		wallSlots[wall].push(slot);
	}

	const need = (wall: WallId) =>
		sum(wallSlots[wall].map((s) => s.slot)) +
		(doorWalls.includes(wall) ? DOOR_WIDTH + 1 : 0);
	const sideNeed = Math.max(need("east"), need("west"));
	const endNeed = Math.max(need("north"), need("south"));
	const tallest = room.artworks.reduce(
		(acc, a) => Math.max(acc, displaySize(a).height),
		0,
	);

	const explicit = room.layout;
	return {
		room,
		pos,
		doorWalls,
		curated: isCurated(room),
		depth:
			explicit?.depth ??
			clamp(sideNeed + ROOM_SIZE_SLACK, MIN_ROOM_DEPTH, MAX_ROOM_DEPTH),
		width:
			explicit?.width ??
			clamp(
				Math.max(endNeed + ROOM_SIZE_SLACK, MIN_AUTO_ROOM_WIDTH),
				MIN_AUTO_ROOM_WIDTH,
				MAX_AUTO_ROOM_WIDTH,
			),
		height: explicit?.height ?? clamp(Math.max(5, tallest + 2.6), 5, 7.5),
		wallSlots,
	};
}

function boundaries(sizes: readonly number[], start: number): number[] {
	const out = [start];
	let cursor = start;
	for (const size of sizes) {
		cursor += size;
		out.push(cursor);
	}
	return out;
}

function planWorld(input: WorldInput): PlannedWorld {
	const generated = input.rooms
		.filter((r) => r.artworks.length > 0)
		.flatMap(splitToCapacity);
	const n = generated.length;
	const cols = gridColumns(n);
	const rows = Math.ceil(n / cols);
	const plans = generated.map((room, i) =>
		planRoom(room, gridPosition(i, cols), doorWallsOf(i, n, cols)),
	);

	const colWidths = Array.from({ length: cols }, () => MIN_AUTO_ROOM_WIDTH);
	const rowDepths = Array.from({ length: rows }, () => 0);
	for (const plan of plans) {
		colWidths[plan.pos.col] = Math.max(
			colWidths[plan.pos.col] ?? 0,
			plan.width,
		);
		rowDepths[plan.pos.row] = Math.max(
			rowDepths[plan.pos.row] ?? 0,
			plan.depth,
		);
	}
	const colX = boundaries(colWidths, -sum(colWidths) / 2);
	const rowZ = boundaries(rowDepths, 0);

	const rooms: RoomLayout3D[] = plans.map((plan, index) => {
		const minX = colX[plan.pos.col] ?? 0;
		const maxX = colX[plan.pos.col + 1] ?? minX;
		const minZ = rowZ[plan.pos.row] ?? 0;
		const maxZ = rowZ[plan.pos.row + 1] ?? minZ;
		return {
			index,
			id: plan.room.id,
			sourceId: plan.room.sourceId,
			name: plan.room.name,
			description: plan.room.description,
			width: maxX - minX,
			depth: maxZ - minZ,
			height: plan.height,
			minX,
			maxX,
			minZ,
			maxZ,
			centerX: (minX + maxX) / 2,
			centerZ: (minZ + maxZ) / 2,
			col: plan.pos.col,
			row: plan.pos.row,
			doors: [],
		};
	});

	for (const [i, from] of rooms.entries()) {
		const to = rooms[i + 1];
		if (!to) break;
		const [wallFrom, wallTo] = doorWallsBetween(
			{ row: from.row, col: from.col },
			{ row: to.row, col: to.col },
		);
		const x =
			wallFrom === "north"
				? from.centerX
				: wallFrom === "east"
					? from.maxX
					: from.minX;
		const z = wallFrom === "north" ? from.maxZ : from.centerZ;
		const opening = { x, z, width: DOOR_WIDTH, height: DOOR_HEIGHT };
		from.doors.push({ ...opening, wall: wallFrom, toRoom: to.index });
		to.doors.push({ ...opening, wall: wallTo, toRoom: from.index });
	}

	return { plans, rooms, cols, rows, colX, rowZ };
}

/** The wall's whole usable run, before a doorway splits it. A pinned
 * `wallOffset` is a fraction of this, so a curated hang keeps the position the
 * curator chose whether or not the wall turns out to carry a door. */
function wallExtent(room: RoomLayout3D, wall: WallId): Span {
	const alongZ = wall === "east" || wall === "west";
	return {
		from: (alongZ ? room.minZ : room.minX) + WALL_END_MARGIN,
		to: (alongZ ? room.maxZ : room.maxX) - WALL_END_MARGIN,
	};
}

/** Free spans along one wall of a room (after end margins), split in two
 * around a doorway when the wall has one. */
function wallSpans(room: RoomLayout3D, wall: WallId): Span[] {
	const extent = wallExtent(room, wall);
	const door = room.doors.find((d) => d.wall === wall);
	if (!door) return [extent];
	const centre = wall === "east" || wall === "west" ? door.z : door.x;
	return [
		{ from: extent.from, to: centre - DOOR_WIDTH / 2 - DOOR_CLEARANCE },
		{ from: centre + DOOR_WIDTH / 2 + DOOR_CLEARANCE, to: extent.to },
	];
}

const pinnedOffset = (slot: Slot) => {
	const offset = slot.artwork.wallOffset;
	return offset != null && offset >= 0 && offset <= 1 ? offset : null;
};

/** Move a pinned centre into the nearest free span, so a hang pinned over a
 * doorway or hard against a corner still clears both. A span too narrow for the
 * slot centres it instead. */
function intoNearestSpan(at: number, slot: Slot, spans: Span[]): number {
	let best = at;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const span of spans) {
		// Clamped by the canvas, not the slot: the slot's breathing room is for
		// spacing auto hangs, and charging it here would pull a pin near either
		// end of the wall visibly inward.
		const low = span.from + slot.width / 2;
		const high = span.to - slot.width / 2;
		const inside =
			low > high
				? (span.from + span.to) / 2
				: Math.min(Math.max(at, low), high);
		const distance = Math.abs(inside - at);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = inside;
		}
	}
	return best;
}

/** Curated walls hang at their pinned fraction of the whole wall — measured
 * across the full extent, not whichever half of a door wall the slot landed in.
 * Slots the curator never pinned space evenly across that same extent. */
function placeCurated(
	slots: Slot[],
	extent: Span,
	spans: Span[],
): { slot: Slot; at: number }[] {
	const length = extent.to - extent.from;
	return slots.map((slot, i) => {
		const fraction = pinnedOffset(slot) ?? (i + 1) / (slots.length + 1);
		return {
			slot,
			at: intoNearestSpan(extent.from + fraction * length, slot, spans),
		};
	});
}

/** Pack auto slots along one free span by width with equal gaps. An over-packed
 * span overlaps its slots evenly rather than running them off the wall. */
function packAlong(slots: Slot[], span: Span): { slot: Slot; at: number }[] {
	const first = slots[0];
	const last = slots[slots.length - 1];
	if (!first || !last) return [];
	const length = span.to - span.from;
	const total = sum(slots.map((s) => s.slot));
	if (total > length) {
		const low = span.from + first.slot / 2;
		const high = span.to - last.slot / 2;
		if (high <= low) {
			// Too narrow to seat even the end slots. Spreading here would run the
			// hang backwards, so fall back to an edge-to-edge row centred on the
			// span: order holds and the overhang is symmetric.
			let cursor = span.from + (length - total) / 2;
			return slots.map((slot) => {
				const at = cursor + slot.slot / 2;
				cursor += slot.slot;
				return { slot, at };
			});
		}
		const step = slots.length > 1 ? (high - low) / (slots.length - 1) : 0;
		return slots.map((slot, i) => ({ slot, at: low + i * step }));
	}
	const gap = (length - total) / (slots.length + 1);
	let cursor = span.from + gap;
	return slots.map((slot) => {
		const at = cursor + slot.slot / 2;
		cursor += slot.slot + gap;
		return { slot, at };
	});
}

/** Where each slot's centre lands along `wall`. */
function placeSlots(
	room: RoomLayout3D,
	wall: WallId,
	slots: Slot[],
): { slot: Slot; at: number }[] {
	const spans = wallSpans(room, wall);
	if (slots.some((slot) => pinnedOffset(slot) != null)) {
		return placeCurated(slots, wallExtent(room, wall), spans);
	}
	const [first, second] = spans;
	if (first && second) {
		return [
			...packAlong(
				slots.filter((_, j) => j % 2 === 0),
				first,
			),
			...packAlong(
				slots.filter((_, j) => j % 2 === 1),
				second,
			),
		];
	}
	return packAlong(slots, first ?? { from: 0, to: 0 });
}

function placeOnWall(
	room: RoomLayout3D,
	wall: WallId,
	slots: Slot[],
): PaintingLayout[] {
	const placed = placeSlots(room, wall, slots);

	const inset = WALL_THICKNESS / 2;
	return placed.map(({ slot, at }) => {
		const y = Math.max(HANG_HEIGHT, slot.height / 2 + 0.55);
		const face: Pick<PaintingLayout, "position" | "rotationY" | "normal"> =
			wall === "east"
				? {
						position: [room.maxX - inset, y, at],
						rotationY: -Math.PI / 2,
						normal: [-1, 0, 0],
					}
				: wall === "west"
					? {
							position: [room.minX + inset, y, at],
							rotationY: Math.PI / 2,
							normal: [1, 0, 0],
						}
					: wall === "north"
						? {
								position: [at, y, room.maxZ - inset],
								rotationY: Math.PI,
								normal: [0, 0, -1],
							}
						: {
								position: [at, y, room.minZ + inset],
								rotationY: 0,
								normal: [0, 0, 1],
							};
		return {
			...face,
			artworkId: slot.artwork.id,
			roomIndex: room.index,
			wall,
			width: slot.width,
			height: slot.height,
		};
	});
}

type WallSegment = { box: Box; collides: boolean };

/** Wall boxes along one grid edge: a solid slab, or two jambs plus a
 * non-colliding lintel when a doorway opens in it. `from`/`to` are the edge's
 * extent along its axis; the slab overshoots by half a thickness at each end so
 * corners close. */
function edgeSegments(
	axis: Doorway["axis"],
	at: number,
	from: number,
	to: number,
	height: number,
	doorCentre: number | null,
): WallSegment[] {
	const slab = (
		a: number,
		b: number,
		y: number,
		h: number,
		thick: number,
	): Box =>
		axis === "x"
			? { position: [(a + b) / 2, y, at], size: [b - a, h, thick] }
			: { position: [at, y, (a + b) / 2], size: [thick, h, b - a] };
	const lo = from - WALL_THICKNESS / 2;
	const hi = to + WALL_THICKNESS / 2;
	if (doorCentre == null) {
		return [
			{ box: slab(lo, hi, height / 2, height, WALL_THICKNESS), collides: true },
		];
	}
	const segments: WallSegment[] = [
		{
			box: slab(
				lo,
				doorCentre - DOOR_WIDTH / 2,
				height / 2,
				height,
				WALL_THICKNESS,
			),
			collides: true,
		},
		{
			box: slab(
				doorCentre + DOOR_WIDTH / 2,
				hi,
				height / 2,
				height,
				WALL_THICKNESS,
			),
			collides: true,
		},
	];
	const lintelH = height - DOOR_HEIGHT;
	if (lintelH > 0.01) {
		segments.push({
			box: slab(
				doorCentre - DOOR_WIDTH / 2 - 0.01,
				doorCentre + DOOR_WIDTH / 2 + 0.01,
				DOOR_HEIGHT + lintelH / 2,
				lintelH,
				WALL_THICKNESS,
			),
			collides: false,
		});
	}
	return segments;
}

function buildWalls(planned: PlannedWorld): WallSegment[] {
	const { rooms, cols, rows, colX, rowZ } = planned;
	const roomAt = new Map<string, RoomLayout3D>();
	for (const room of rooms) roomAt.set(`${room.row}:${room.col}`, room);
	const cell = (row: number, col: number) => roomAt.get(`${row}:${col}`);
	const doorBetween = (
		a: RoomLayout3D | undefined,
		b: RoomLayout3D | undefined,
	) => (a && b ? a.doors.find((d) => d.toRoom === b.index) : undefined);

	const segments: WallSegment[] = [];
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col <= cols; col++) {
			const west = cell(row, col - 1);
			const east = cell(row, col);
			if (!west && !east) continue;
			const height = Math.max(west?.height ?? 0, east?.height ?? 0);
			segments.push(
				...edgeSegments(
					"z",
					colX[col] ?? 0,
					rowZ[row] ?? 0,
					rowZ[row + 1] ?? 0,
					height,
					doorBetween(west, east)?.z ?? null,
				),
			);
		}
	}
	for (let col = 0; col < cols; col++) {
		for (let row = 0; row <= rows; row++) {
			const south = cell(row - 1, col);
			const north = cell(row, col);
			if (!south && !north) continue;
			const height = Math.max(south?.height ?? 0, north?.height ?? 0);
			segments.push(
				...edgeSegments(
					"x",
					rowZ[row] ?? 0,
					colX[col] ?? 0,
					colX[col + 1] ?? 0,
					height,
					doorBetween(south, north)?.x ?? null,
				),
			);
		}
	}
	return segments;
}

function boxTouchesRect(box: Box, rect: Rect, margin: number): boolean {
	const [cx, , cz] = box.position;
	const [sx, , sz] = box.size;
	return (
		cx + sx / 2 >= rect.minX - margin &&
		cx - sx / 2 <= rect.maxX + margin &&
		cz + sz / 2 >= rect.minZ - margin &&
		cz - sz / 2 <= rect.maxZ + margin
	);
}

/** Build the walkable world for a museum or single-room gallery. Rooms with
 * no artworks are dropped; over-full auto rooms split into wings first. */
export function buildWorldLayout(input: WorldInput): WorldLayout {
	const planned = planWorld(input);
	const { plans, rooms, colX, rowZ } = planned;

	const segments = buildWalls(planned);
	const walls = segments.map((s) => s.box);
	const colliders = segments.filter((s) => s.collides).map((s) => s.box);

	const margin = PLAYER_RADIUS + WALL_THICKNESS;
	const collidersByRoom = rooms.map((room) => {
		const nearby = [room, ...room.doors.map((d) => rooms[d.toRoom])].filter(
			(r): r is RoomLayout3D => r != null,
		);
		return colliders.filter((box) =>
			nearby.some((r) => boxTouchesRect(box, r, margin)),
		);
	});

	const paintings: PaintingLayout[] = [];
	const paintingsByRoom: number[][] = [];
	for (const [i, plan] of plans.entries()) {
		const room = rooms[i];
		if (!room) continue;
		const indices: number[] = [];
		for (const wall of WALL_ORDER) {
			for (const painting of placeOnWall(room, wall, plan.wallSlots[wall])) {
				indices.push(paintings.length);
				paintings.push(painting);
			}
		}
		paintingsByRoom.push(indices);
	}

	const tourOrder: number[] = [];
	const visited = new Set<number>();
	for (const [i, plan] of plans.entries()) {
		const inRoom = paintingsByRoom[i] ?? [];
		for (const artwork of plan.room.artworks) {
			const idx = inRoom.find(
				(p) => !visited.has(p) && paintings[p]?.artworkId === artwork.id,
			);
			if (idx == null) continue;
			visited.add(idx);
			tourOrder.push(idx);
		}
	}

	const doorways: Doorway[] = rooms.flatMap((room) =>
		room.doors
			.filter((d) => d.toRoom === room.index + 1)
			.map((d) => ({
				x: d.x,
				z: d.z,
				axis: d.wall === "north" || d.wall === "south" ? "x" : "z",
				width: d.width,
				height: d.height,
				rooms: [room.index, d.toRoom],
			})),
	);

	const first = rooms[0];
	const spawn: [number, number, number] = first
		? [first.centerX, EYE_HEIGHT, first.minZ + Math.min(3.2, first.depth / 2)]
		: [0, EYE_HEIGHT, 0];

	return {
		bounds: {
			minX: colX[0] ?? 0,
			maxX: colX[colX.length - 1] ?? 0,
			minZ: rowZ[0] ?? 0,
			maxZ: rowZ[rowZ.length - 1] ?? 0,
		},
		maxHeight: rooms.reduce((acc, r) => Math.max(acc, r.height), 0),
		rooms,
		walls,
		colliders,
		collidersByRoom,
		paintings,
		paintingsByRoom,
		doorways,
		spawn,
		spawnYaw: Math.PI,
		tourOrder,
	};
}

/** Per generated room: the wall loads the renderer will actually produce, so
 * the linter and the wall editor warn about exactly what would overflow. */
export function analyzeWorld(input: WorldInput): RoomAnalysis[] {
	const { plans, rooms } = planWorld(input);
	return plans.flatMap((plan, i) => {
		const room = rooms[i];
		if (!room) return [];
		const walls = WALL_ORDER.map((wall): WallLoad => {
			const slots = plan.wallSlots[wall];
			const required = sum(slots.map((s) => s.slot));
			const available = sum(wallSpans(room, wall).map((s) => s.to - s.from));
			return {
				wall,
				count: slots.length,
				required,
				available,
				overflow: slots.length > 0 && required > available,
				hasDoor: plan.doorWalls.includes(wall),
			};
		});
		return [
			{
				roomId: room.id,
				sourceId: room.sourceId,
				roomName: room.name,
				width: room.width,
				depth: room.depth,
				height: room.height,
				curated: plan.curated,
				walls,
			},
		];
	});
}

/** Index of the room whose footprint contains (x, z), or -1. */
export function roomIndexAt(world: WorldLayout, x: number, z: number): number {
	return world.rooms.findIndex(
		(r) => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ,
	);
}

/** Eye-height waypoints through the doorways between two rooms, following the
 * room order (which is the snake path). Empty for the same room. */
export function doorwayWaypoints(
	world: WorldLayout,
	fromRoom: number,
	toRoom: number,
): Vec3Like[] {
	const step = fromRoom < toRoom ? 1 : -1;
	const points: Vec3Like[] = [];
	for (let k = fromRoom; k !== toRoom; k += step) {
		const door = world.rooms[k]?.doors.find((d) => d.toRoom === k + step);
		if (!door) break;
		points.push({ x: door.x, y: EYE_HEIGHT, z: door.z });
	}
	return points;
}

/** Axis-separated AABB collision against `colliders`; returns where the
 * player may actually end up. */
export function collideAndSlide(
	from: { x: number; z: number },
	to: { x: number; z: number },
	colliders: readonly Box[],
): { x: number; z: number } {
	const r = PLAYER_RADIUS;
	const blocked = (x: number, z: number) =>
		colliders.some((c) => {
			const [cx, , cz] = c.position;
			const [sx, , sz] = c.size;
			return Math.abs(x - cx) < sx / 2 + r && Math.abs(z - cz) < sz / 2 + r;
		});
	const x = blocked(to.x, from.z) ? from.x : to.x;
	const z = blocked(x, to.z) ? from.z : to.z;
	return { x, z };
}

/** How far short of a painting an occluder has to sit to count as blocking it.
 * A canvas hangs on the inner face of its wall box, so the ray reaches both at
 * the same distance. */
const OCCLUSION_MARGIN = 0.05;

/** Whether the ray meets an axis-aligned box within `maxT`. Slab test. */
function rayHitsBox(
	origin: Vec3Like,
	direction: Vec3Like,
	box: Box,
	maxT: number,
): boolean {
	let near = 0;
	let far = maxT;
	const o = [origin.x, origin.y, origin.z];
	const d = [direction.x, direction.y, direction.z];
	for (let axis = 0; axis < 3; axis++) {
		const from = o[axis] ?? 0;
		const along = d[axis] ?? 0;
		const half = (box.size[axis] ?? 0) / 2;
		const min = (box.position[axis] ?? 0) - half;
		const max = (box.position[axis] ?? 0) + half;
		if (Math.abs(along) < 1e-6) {
			if (from < min || from > max) return false;
			continue;
		}
		const t1 = (min - from) / along;
		const t2 = (max - from) / along;
		near = Math.max(near, Math.min(t1, t2));
		far = Math.min(far, Math.max(t1, t2));
		if (near > far) return false;
	}
	return true;
}

/** Nearest painting among `candidates` (indices into `world.paintings`) whose
 * padded canvas rectangle the ray crosses front-on within `maxDistance`.
 * Returns the painting index or -1. Allocation-free so it can run every frame.
 * Pass `occluders` to reject a hit that a wall stands in front of — a tap can
 * aim metres past the crosshair, so without it the pick reaches through walls
 * into the next room. */
export function pickPaintingRay(
	world: WorldLayout,
	candidates: readonly number[],
	origin: Vec3Like,
	direction: Vec3Like,
	maxDistance: number,
	pad: number,
	occluders?: readonly Box[],
): number {
	let best = -1;
	let bestT = Number.POSITIVE_INFINITY;
	for (let c = 0; c < candidates.length; c++) {
		const index = candidates[c];
		if (index == null) continue;
		const p = world.paintings[index];
		if (!p) continue;
		const nx = p.normal[0];
		const ny = p.normal[1];
		const nz = p.normal[2];
		const denom = direction.x * nx + direction.y * ny + direction.z * nz;
		if (denom >= -1e-6) continue;
		const px = p.position[0];
		const py = p.position[1];
		const pz = p.position[2];
		const t =
			((px - origin.x) * nx + (py - origin.y) * ny + (pz - origin.z) * nz) /
			denom;
		if (t <= 0 || t > maxDistance || t >= bestT) continue;
		const hx = origin.x + direction.x * t - px;
		const hy = origin.y + direction.y * t - py;
		const hz = origin.z + direction.z * t - pz;
		// Wall-right axis is normal × up = (-nz, 0, nx).
		const u = hx * -nz + hz * nx;
		if (Math.abs(u) > p.width / 2 + pad || Math.abs(hy) > p.height / 2 + pad) {
			continue;
		}
		best = index;
		bestT = t;
	}
	if (best < 0 || !occluders) return best;
	const reach = bestT - OCCLUSION_MARGIN;
	for (const box of occluders) {
		if (rayHitsBox(origin, direction, box, reach)) return -1;
	}
	return best;
}

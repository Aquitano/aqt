import { describe, expect, test } from "bun:test";

import {
	analyzeWorld,
	buildWorldLayout,
	DOOR_WIDTH,
	doorwayWaypoints,
	pickPaintingRay,
	roomIndexAt,
	WALL_END_MARGIN,
	type WallId,
	type WorldRoomInput,
} from "./index";

function work(id: string, wall: WallId | null = null) {
	return { id, dimensions: "50 × 50 cm", wall };
}

function room(id: string, count: number, wall: WallId | null = null) {
	return {
		id,
		name: id,
		description: null,
		layout: null,
		artworks: Array.from({ length: count }, (_, i) => work(`${id}-${i}`, wall)),
	} satisfies WorldRoomInput;
}

const autoRooms = (n: number) =>
	Array.from({ length: n }, (_, i) => room(`r${i}`, 2));

describe("buildWorldLayout floor plan", () => {
	test("up to three rooms form a single column joined by north/south doors", () => {
		const world = buildWorldLayout({ rooms: autoRooms(3) });
		expect(world.rooms.map((r) => r.col)).toEqual([0, 0, 0]);
		expect(world.rooms.map((r) => r.row)).toEqual([0, 1, 2]);
		expect(world.rooms[0]?.doors.map((d) => d.wall)).toEqual(["north"]);
		expect(world.rooms[1]?.doors.map((d) => d.wall).sort()).toEqual([
			"north",
			"south",
		]);
		expect(world.rooms[2]?.doors.map((d) => d.wall)).toEqual(["south"]);
	});

	test("25 auto rooms snake through a 5x5 grid with one shared door per step", () => {
		const world = buildWorldLayout({ rooms: autoRooms(25) });
		expect(Math.max(...world.rooms.map((r) => r.col))).toBe(4);
		expect(Math.max(...world.rooms.map((r) => r.row))).toBe(4);

		for (const [i, a] of world.rooms.entries()) {
			expect(a.doors.length).toBeLessThanOrEqual(2);
			const b = world.rooms[i + 1];
			if (!b) continue;
			const shared = a.doors.filter((d) => d.toRoom === b.index);
			expect(shared).toHaveLength(1);
			const door = shared[0];
			if (!door) throw new Error("door missing");
			const onBoundary =
				door.wall === "north" || door.wall === "south"
					? a.maxZ === b.minZ && door.z === a.maxZ
					: (a.maxX === b.minX && door.x === a.maxX) ||
						(a.minX === b.maxX && door.x === a.minX);
			expect(onBoundary).toBe(true);
			expect(door.x).toBeGreaterThanOrEqual(Math.max(a.minX, b.minX));
			expect(door.x).toBeLessThanOrEqual(Math.min(a.maxX, b.maxX));
			expect(door.z).toBeGreaterThanOrEqual(Math.max(a.minZ, b.minZ));
			expect(door.z).toBeLessThanOrEqual(Math.min(a.maxZ, b.maxZ));
		}

		for (const a of world.rooms) {
			for (const b of world.rooms) {
				if (a.index === b.index) continue;
				const overlap =
					a.minX < b.maxX &&
					b.minX < a.maxX &&
					a.minZ < b.maxZ &&
					b.minZ < a.maxZ;
				expect(overlap).toBe(false);
			}
		}
		expect(world.doorways).toHaveLength(24);
	});

	test("an over-full auto room splits into wings that never overflow", () => {
		const analyses = analyzeWorld({ rooms: [room("big", 100)] });
		expect(analyses.length).toBeGreaterThan(1);
		expect(analyses.every((a) => a.sourceId === "big")).toBe(true);
		expect(analyses[1]?.roomId).toBe("big__wing-2");
		expect(analyses[1]?.roomName).toBe("big · II");
		for (const analysis of analyses) {
			for (const wall of analysis.walls) expect(wall.overflow).toBe(false);
		}
		const hung = buildWorldLayout({ rooms: [room("big", 100)] });
		expect(hung.paintings).toHaveLength(100);
		expect(hung.tourOrder).toHaveLength(100);
	});

	test("paintings pinned to a door wall stay clear of the opening", () => {
		const first = {
			...room("a", 1),
			artworks: [] as ReturnType<typeof work>[],
		};
		first.artworks = Array.from({ length: 4 }, (_, i) =>
			work(`a-${i}`, "north"),
		);
		const world = buildWorldLayout({ rooms: [first, room("b", 1)] });
		const door = world.rooms[0]?.doors.find((d) => d.wall === "north");
		if (!door) throw new Error("door missing");
		const northPaintings = world.paintings.filter(
			(p) => p.roomIndex === 0 && p.wall === "north",
		);
		expect(northPaintings).toHaveLength(4);
		for (const p of northPaintings) {
			const left = p.position[0] - p.width / 2;
			const right = p.position[0] + p.width / 2;
			const clear =
				right <= door.x - DOOR_WIDTH / 2 || left >= door.x + DOOR_WIDTH / 2;
			expect(clear).toBe(true);
		}
	});
});

describe("analyzeWorld", () => {
	test("flags a small curated room with six works pinned to one wall", () => {
		const [analysis] = analyzeWorld({
			rooms: [
				{
					...room("tight", 6, "east"),
					layout: { width: 13, depth: 12, height: 5 },
				},
			],
		});
		expect(analysis?.curated).toBe(true);
		const east = analysis?.walls.find((w) => w.wall === "east");
		expect(east?.count).toBe(6);
		expect(east?.overflow).toBe(true);
		expect(analysis?.walls.find((w) => w.wall === "west")?.overflow).toBe(
			false,
		);
	});
});

describe("navigation helpers", () => {
	const world = buildWorldLayout({ rooms: autoRooms(3) });

	test("pickPaintingRay hits the painting ahead and ignores others", () => {
		const target = world.paintings.findIndex(
			(p) => p.roomIndex === 0 && p.wall === "east",
		);
		const painting = world.paintings[target];
		if (!painting) throw new Error("painting missing");
		const origin = {
			x: painting.position[0] - 3,
			y: painting.position[1],
			z: painting.position[2],
		};
		const towards = { x: 1, y: 0, z: 0 };
		const all = world.paintings.map((_, i) => i);
		expect(pickPaintingRay(world, all, origin, towards, 10, 0.1)).toBe(target);
		expect(pickPaintingRay(world, all, origin, towards, 2, 0.1)).toBe(-1);
		expect(
			pickPaintingRay(world, [target], origin, { x: -1, y: 0, z: 0 }, 10, 0.1),
		).toBe(-1);
	});

	test("pickPaintingRay stops at a wall between the eye and the canvas", () => {
		const target = world.paintings.findIndex(
			(p) => p.roomIndex === 0 && p.wall === "east",
		);
		const painting = world.paintings[target];
		const first = world.rooms[0];
		if (!painting || !first) throw new Error("painting missing");
		const towards = { x: 1, y: 0, z: 0 };
		const outside = {
			x: first.minX - 2,
			y: painting.position[1],
			z: painting.position[2],
		};
		const range = painting.position[0] - outside.x + 1;

		expect(pickPaintingRay(world, [target], outside, towards, range, 0.1)).toBe(
			target,
		);
		expect(
			pickPaintingRay(
				world,
				[target],
				outside,
				towards,
				range,
				0.1,
				world.walls,
			),
		).toBe(-1);

		const inside = { ...outside, x: painting.position[0] - 3 };
		expect(
			pickPaintingRay(world, [target], inside, towards, 10, 0.1, world.walls),
		).toBe(target);
	});

	test("doorwayWaypoints routes through each door centre in order", () => {
		const points = doorwayWaypoints(world, 0, 2);
		expect(points).toHaveLength(2);
		expect(points[0]?.z).toBe(world.rooms[0]?.maxZ);
		expect(points[1]?.z).toBe(world.rooms[1]?.maxZ);
		expect(doorwayWaypoints(world, 2, 0).map((p) => p.z)).toEqual(
			points.map((p) => p.z).reverse(),
		);
		expect(doorwayWaypoints(world, 1, 1)).toEqual([]);
	});

	test("roomIndexAt finds the containing room and -1 outside", () => {
		const second = world.rooms[1];
		if (!second) throw new Error("room missing");
		expect(roomIndexAt(world, second.centerX, second.centerZ)).toBe(1);
		expect(roomIndexAt(world, world.bounds.maxX + 5, 0)).toBe(-1);
	});
});

describe("curated wall offsets", () => {
	/** Four rooms sit in a 2x2 grid, so room 0 carries an east door — the case
	 * where the wall's free run is split in two. */
	const curatedRoom = (
		offsets: number[],
		depth: number | null = null,
	): WorldRoomInput => ({
		id: "curated",
		name: "curated",
		description: null,
		layout: depth == null ? null : { depth },
		artworks: offsets.map((wallOffset, i) => ({
			id: `c-${i}`,
			dimensions: "50 × 50 cm",
			wall: "east" as const,
			wallOffset,
		})),
	});

	test("a pinned offset measures across the whole wall, not the half a door leaves", () => {
		const world = buildWorldLayout({
			rooms: [
				curatedRoom([0.25, 0.75], 30),
				room("r1", 2),
				room("r2", 2),
				room("r3", 2),
			],
		});
		const first = world.rooms[0];
		if (!first) throw new Error("room missing");
		expect(first.doors.some((d) => d.wall === "east")).toBe(true);

		const from = first.minZ + WALL_END_MARGIN;
		const to = first.maxZ - WALL_END_MARGIN;
		const placed = world.paintings
			.filter((p) => p.roomIndex === 0 && p.wall === "east")
			.map((p) => p.position[2])
			.sort((a, b) => a - b);

		expect(placed).toHaveLength(2);
		expect(placed[0]).toBeCloseTo(from + 0.25 * (to - from), 5);
		expect(placed[1]).toBeCloseTo(from + 0.75 * (to - from), 5);
	});

	test("a hang pinned to the start of a wall keeps its canvas on the wall", () => {
		const world = buildWorldLayout({ rooms: [curatedRoom([0], 30)] });
		const first = world.rooms[0];
		const painting = world.paintings.find(
			(p) => p.roomIndex === 0 && p.wall === "east",
		);
		if (!first || !painting) throw new Error("setup missing");

		// Pinned hard against the start: the canvas edge sits on the wall's first
		// usable point, not a slot's breathing room further in.
		const from = first.minZ + WALL_END_MARGIN;
		expect(painting.position[2]).toBeCloseTo(from + painting.width / 2, 5);
	});

	test("a hang pinned onto the doorway is nudged clear of it", () => {
		const world = buildWorldLayout({
			rooms: [curatedRoom([0.5]), room("r1", 2), room("r2", 2), room("r3", 2)],
		});
		const first = world.rooms[0];
		const door = first?.doors.find((d) => d.wall === "east");
		const painting = world.paintings.find(
			(p) => p.roomIndex === 0 && p.wall === "east",
		);
		if (!first || !door || !painting) throw new Error("setup missing");

		const clearance = Math.abs(painting.position[2] - door.z);
		expect(clearance).toBeGreaterThan(DOOR_WIDTH / 2);
		expect(painting.position[2] - painting.width / 2).toBeGreaterThan(
			first.minZ,
		);
		expect(painting.position[2] + painting.width / 2).toBeLessThan(first.maxZ);
	});
});

describe("over-packed walls", () => {
	test("an over-packed wall keeps its hang order", () => {
		const wide = (id: string) => ({
			id,
			dimensions: "200 × 600 cm",
			wall: "east" as const,
		});
		const world = buildWorldLayout({
			rooms: [
				{
					id: "packed",
					name: "packed",
					description: null,
					layout: { depth: 12 },
					artworks: [wide("a"), wide("b"), wide("c"), wide("d")],
				},
			],
		});

		const hung = world.paintings
			.filter((p) => p.roomIndex === 0 && p.wall === "east")
			.map((p) => p.position[2]);
		expect(hung).toHaveLength(4);
		for (let i = 1; i < hung.length; i++) {
			expect(hung[i] ?? 0).toBeGreaterThan(hung[i - 1] ?? 0);
		}
	});
});

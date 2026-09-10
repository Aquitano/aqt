import type { WorldLayout } from "@aqt-gallery/gallery-layout";

/** Rooms reachable from `start` through at most `radius` doorways, `start`
 * included. Adjacency follows the doors rather than room order so the window
 * stays right for any floor-plan graph the layout package produces. */
export function roomWindow(
	world: WorldLayout,
	start: number,
	radius: number,
): number[] {
	if (!world.rooms[start]) return [];
	const seen = new Set<number>([start]);
	let frontier = [start];
	for (let depth = 0; depth < radius && frontier.length > 0; depth++) {
		const next: number[] = [];
		for (const index of frontier) {
			for (const door of world.rooms[index]?.doors ?? []) {
				if (seen.has(door.toRoom)) continue;
				seen.add(door.toRoom);
				next.push(door.toRoom);
			}
		}
		frontier = next;
	}
	return [...seen];
}

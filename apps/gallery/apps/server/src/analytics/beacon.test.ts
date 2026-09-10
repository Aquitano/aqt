import { describe, expect, mock, test } from "bun:test";

// beacon.ts imports the singleton `db`, whose module validates the server env
// and opens a Postgres connection at import time. planIncrements and utcDay are
// pure and never touch it, so a stub is enough to keep the import graph loadable
// under test. The upsert path needs a live Postgres and is not exercised here.
mock.module("@aqt-gallery/db", () => ({ db: {} }));

const { planIncrements, utcDay } = await import("./beacon");
type BeaconEvent = import("./beacon").BeaconEvent;

const publishAll = () => true;
const allowAllArtworks = () => true;

function evt(over: Partial<BeaconEvent> = {}): BeaconEvent {
	return {
		entityKind: "exhibition",
		entityId: "m1",
		metric: "page_view",
		...over,
	};
}

describe("planIncrements", () => {
	test("folds repeated events into a single counted increment", () => {
		const result = planIncrements(
			[evt(), evt(), evt()],
			publishAll,
			allowAllArtworks,
		);
		expect(result).toEqual([
			{
				entityKind: "exhibition",
				entityId: "m1",
				metric: "page_view",
				artworkId: "",
				count: 3,
			},
		]);
	});

	test("separates metrics, entities and inspected artworks", () => {
		const result = planIncrements(
			[
				evt({ metric: "page_view" }),
				evt({ metric: "session_entered" }),
				evt({ metric: "inspect_open", artworkId: "a1" }),
				evt({ metric: "inspect_open", artworkId: "a1" }),
				evt({ metric: "inspect_open", artworkId: "a2" }),
				evt({ entityId: "e2", metric: "page_view" }),
			],
			publishAll,
			allowAllArtworks,
		);
		const byKey = new Map(
			result.map((r) => [`${r.metric}:${r.artworkId}:${r.entityId}`, r.count]),
		);
		expect(byKey.get("page_view::m1")).toBe(1);
		expect(byKey.get("session_entered::m1")).toBe(1);
		expect(byKey.get("inspect_open:a1:m1")).toBe(2);
		expect(byKey.get("inspect_open:a2:m1")).toBe(1);
		expect(byKey.get("page_view::e2")).toBe(1);
	});

	test("drops artworkId for non-inspect metrics", () => {
		const [inc] = planIncrements(
			[evt({ metric: "tour_completed", artworkId: "a9" })],
			publishAll,
			allowAllArtworks,
		);
		expect(inc?.artworkId).toBe("");
	});

	test("drops events for unpublished or unknown entities", () => {
		const result = planIncrements(
			[evt({ entityId: "published" }), evt({ entityId: "draft" })],
			(_kind, id) => id === "published",
			allowAllArtworks,
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.entityId).toBe("published");
	});

	test("drops inspect_open events for artworks the entity doesn't contain", () => {
		const result = planIncrements(
			[
				evt({ metric: "inspect_open", artworkId: "hung" }),
				evt({ metric: "inspect_open", artworkId: "junk" }),
			],
			publishAll,
			(_kind, _entityId, artworkId) => artworkId === "hung",
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.artworkId).toBe("hung");
	});

	test("validates the inspected artwork against its own entity", () => {
		const result = planIncrements(
			[
				evt({ entityId: "m1", metric: "inspect_open", artworkId: "a1" }),
				evt({ entityId: "m2", metric: "inspect_open", artworkId: "a1" }),
			],
			publishAll,
			(_kind, entityId, artworkId) => entityId === "m1" && artworkId === "a1",
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.entityId).toBe("m1");
	});

	test("keeps inspect_open events that carry no artworkId", () => {
		const result = planIncrements(
			[evt({ metric: "inspect_open" })],
			publishAll,
			() => false,
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.artworkId).toBe("");
	});
});

describe("utcDay", () => {
	test("formats a UTC day bucket", () => {
		expect(utcDay(new Date("2026-07-07T23:30:00Z"))).toBe("2026-07-07");
	});
});

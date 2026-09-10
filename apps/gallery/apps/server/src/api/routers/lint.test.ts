import { describe, expect, test } from "bun:test";

import {
	type LintArtwork,
	type LintMember,
	type LintRoomInput,
	runLint,
} from "./lint";

function art(over: Partial<LintArtwork> = {}): LintArtwork {
	return {
		id: "a1",
		title: "A Work",
		dimensions: "50 × 50 cm",
		story: "A short story.",
		artistId: "artist-1",
		artistName: "Someone",
		hasImage: true,
		imageWidth: 800,
		imageHeight: 800,
		isPublished: true,
		isDeleted: false,
		...over,
	};
}

function member(
	artwork: LintArtwork | null,
	placement: Partial<LintMember> = {},
): LintMember {
	return {
		artworkId: artwork?.id ?? "missing",
		artwork,
		wall: null,
		wallOffset: null,
		scale: null,
		...placement,
	};
}

function gallery(members: LintMember[]): LintRoomInput[] {
	return [{ id: "g1", name: "Gallery", layout: null, members }];
}

const has = (report: ReturnType<typeof runLint>, code: string) =>
	report.findings.some((f) => f.code === code);

describe("runLint", () => {
	test("a complete gallery passes clean", () => {
		const report = runLint({
			kind: "gallery",
			name: "Gallery",
			rooms: gallery([member(art())]),
		});
		expect(report.ok).toBe(true);
		expect(report.errorCount).toBe(0);
		expect(report.warningCount).toBe(0);
	});

	test("a deleted member is a blocking error", () => {
		const report = runLint({
			kind: "gallery",
			name: "Gallery",
			rooms: gallery([member(art({ isDeleted: true }))]),
		});
		expect(report.ok).toBe(false);
		expect(has(report, "member_deleted")).toBe(true);
		// The only member can't render → nothing to show.
		expect(has(report, "nothing_to_render")).toBe(true);
	});

	test("a member with no image warns but still renders", () => {
		const report = runLint({
			kind: "gallery",
			name: "Gallery",
			rooms: gallery([member(art({ hasImage: false }))]),
		});
		expect(report.ok).toBe(true);
		expect(has(report, "member_no_image")).toBe(true);
	});

	test("aggregates missing story, dimensions and attribution", () => {
		const report = runLint({
			kind: "gallery",
			name: "Gallery",
			rooms: gallery([
				member(
					art({
						story: null,
						dimensions: null,
						artistId: null,
						artistName: null,
					}),
				),
			]),
		});
		expect(has(report, "missing_story")).toBe(true);
		expect(has(report, "missing_dimensions")).toBe(true);
		expect(has(report, "missing_artist")).toBe(true);
	});

	test("flags an unparseable (but present) dimensions string", () => {
		const report = runLint({
			kind: "gallery",
			name: "Gallery",
			rooms: gallery([member(art({ dimensions: "very large" }))]),
		});
		expect(has(report, "dimensions_unparseable")).toBe(true);
		expect(has(report, "missing_dimensions")).toBe(false);
	});

	test("flags an image whose shape disagrees with the dimensions", () => {
		const report = runLint({
			kind: "gallery",
			name: "Gallery",
			rooms: gallery([
				member(
					art({
						dimensions: "207 × 319 cm",
						imageWidth: 1589,
						imageHeight: 1920,
					}),
				),
			]),
		});
		expect(has(report, "aspect_mismatch")).toBe(true);
	});

	test("warns about an empty museum room", () => {
		const report = runLint({
			kind: "museum",
			name: "Museum",
			rooms: [
				{ id: "r1", name: "Hall A", layout: null, members: [member(art())] },
				{ id: "r2", name: "Hall B", layout: null, members: [] },
			],
		});
		expect(has(report, "empty_room")).toBe(true);
		expect(report.ok).toBe(true);
	});

	test("flags an over-packed curated wall", () => {
		const works = Array.from({ length: 6 }, (_, i) =>
			member(art({ id: `a${i}`, dimensions: "50 × 50 cm" }), {
				artworkId: `a${i}`,
				wall: "east",
			}),
		);
		const report = runLint({
			kind: "museum",
			name: "Museum",
			rooms: [
				{
					id: "r1",
					name: "Tight Hall",
					layout: { width: 13, depth: 12, height: 5 },
					members: works,
				},
			],
		});
		expect(has(report, "wall_overflow")).toBe(true);
		const finding = report.findings.find((f) => f.code === "wall_overflow");
		expect(finding?.wall).toBe("east");
	});

	test("an empty gallery cannot render", () => {
		const report = runLint({
			kind: "gallery",
			name: "Gallery",
			rooms: gallery([]),
		});
		expect(report.ok).toBe(false);
		expect(has(report, "nothing_to_render")).toBe(true);
	});

	test("a hung id that no longer resolves is a blocking error", () => {
		const report = runLint({
			kind: "gallery",
			name: "Gallery",
			rooms: gallery([member(null)]),
		});
		expect(report.ok).toBe(false);
		expect(has(report, "member_missing")).toBe(true);
		// The only member is non-renderable → nothing to show.
		expect(has(report, "nothing_to_render")).toBe(true);
	});

	test("an unpublished member is a blocking error", () => {
		const report = runLint({
			kind: "gallery",
			name: "Gallery",
			rooms: gallery([member(art({ isPublished: false }))]),
		});
		expect(report.ok).toBe(false);
		expect(has(report, "member_unpublished")).toBe(true);
		expect(has(report, "nothing_to_render")).toBe(true);
	});

	test("a museum with no displayable artworks uses the museum-wide message", () => {
		const report = runLint({
			kind: "museum",
			name: "Museum",
			rooms: [
				{ id: "r1", name: "Hall A", layout: null, members: [] },
				{
					id: "r2",
					name: "Hall B",
					layout: null,
					members: [member(art({ isDeleted: true }))],
				},
			],
		});
		expect(report.ok).toBe(false);
		expect(has(report, "nothing_to_render")).toBe(true);
		const finding = report.findings.find((f) => f.code === "nothing_to_render");
		expect(finding?.message).toContain("in any room");
	});

	test("counts an artwork hung in multiple museum rooms once", () => {
		const shared = art({ id: "shared" });
		const report = runLint({
			kind: "museum",
			name: "Museum",
			rooms: [
				{
					id: "r1",
					name: "Hall A",
					layout: null,
					members: [member(shared, { artworkId: "shared" })],
				},
				{
					id: "r2",
					name: "Hall B",
					layout: null,
					members: [member(shared, { artworkId: "shared" })],
				},
			],
		});
		expect(report.artworkCount).toBe(1);
	});

	test("a narrow curated end wall is not flagged against the wider building", () => {
		// Room A pins width 13; its 4 south-wall works (2.6m each = 10.4m) exceed
		// its own end span (~9.8m) but fit the shared column width set by the wider
		// sibling (24m → ~20.8m). Rooms fill their grid cell, so this must NOT be
		// flagged.
		const southWorks = Array.from({ length: 4 }, (_, i) =>
			member(art({ id: `as${i}`, dimensions: "50 × 50 cm" }), {
				artworkId: `as${i}`,
				wall: "south",
			}),
		);
		const report = runLint({
			kind: "museum",
			name: "Museum",
			rooms: [
				{
					id: "rA",
					name: "Narrow Hall",
					layout: { width: 13, depth: 12, height: 5 },
					members: southWorks,
				},
				{
					id: "rB",
					name: "Wide Hall",
					layout: { width: 24, depth: 12, height: 5 },
					members: [
						member(art({ id: "b0", dimensions: "50 × 50 cm" }), {
							artworkId: "b0",
							wall: "east",
						}),
					],
				},
			],
		});
		expect(
			report.findings.some(
				(f) => f.code === "wall_overflow" && f.roomId === "rA",
			),
		).toBe(false);
	});

	test("a curated middle-room end wall overflows including the door reserve", () => {
		// Three rooms stack in one column, so the middle room has a door in both
		// its south and north wall and each loses DOOR_WIDTH + clearance. Its 4
		// north-wall works (10.4m) exceed the ~5.4m that remains on a 13m-wide wall.
		const northWorks = Array.from({ length: 4 }, (_, i) =>
			member(art({ id: `an${i}`, dimensions: "50 × 50 cm" }), {
				artworkId: `an${i}`,
				wall: "north",
			}),
		);
		const report = runLint({
			kind: "museum",
			name: "Museum",
			rooms: [
				{
					id: "r0",
					name: "Hall A",
					layout: null,
					members: [member(art({ id: "x0" }), { artworkId: "x0" })],
				},
				{
					id: "r1",
					name: "Middle Hall",
					layout: { width: 13, depth: 12, height: 5 },
					members: northWorks,
				},
				{
					id: "r2",
					name: "Hall C",
					layout: null,
					members: [member(art({ id: "x2" }), { artworkId: "x2" })],
				},
			],
		});
		const finding = report.findings.find(
			(f) => f.code === "wall_overflow" && f.roomId === "r1",
		);
		expect(finding).toBeDefined();
		expect(finding?.wall).toBe("north");
	});
});

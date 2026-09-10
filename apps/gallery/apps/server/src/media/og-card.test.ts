import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exhibition, placement, room } from "@aqt-gallery/db/schema/exhibition";
import { artwork } from "@aqt-gallery/db/schema/gallery";
import sharp from "sharp";

import type { MediaStore } from "./store";

// og-card.ts (through public-image.ts) imports the singleton `db`, whose module
// opens a real Postgres connection at import time. Mock the specifier before
// importing the module under test. The builder is thenable so a query resolves
// wherever the chain ends — sourceFor stops at `.limit(1)`, the card's count
// queries at `.where(...)`/`.orderBy(...)`. `rowsFor` is swapped per test and
// keyed by the table object identity so each table's query resolves
// independently.
type Row = Record<string, unknown>;
let rowsFor: (table: unknown) => Row[] = () => [];

mock.module("@aqt-gallery/db", () => ({
	db: {
		select() {
			let table: unknown;
			const builder = {
				from(t: unknown) {
					table = t;
					return builder;
				},
				leftJoin() {
					return builder;
				},
				where() {
					return builder;
				},
				orderBy() {
					return builder;
				},
				limit() {
					return Promise.resolve(rowsFor(table));
				},
				// biome-ignore lint/suspicious/noThenProperty: the thenable builder is the point — it lets `await` resolve a query wherever the chain ends.
				then<T>(resolve: (rows: Row[]) => T, reject?: (err: unknown) => T) {
					return Promise.resolve(rowsFor(table)).then(resolve, reject);
				},
			};
			return builder;
		},
	},
}));

// Dynamic import so the mock above is registered first (static imports hoist).
const { serveOgCard, ogCardCacheTargets } = await import("./og-card");
const { deleteEntityCacheFiles } = await import("./delete-files");
const { createDiskStore } = await import("./store");

/** The cache key of a card, as a path under the temp disk root. */
function cardFile(root: string, id: string): string {
	return path.join(root, ogCardCacheTargets(id)[0] ?? "");
}

const realFetch = globalThis.fetch;

/** Stub the upstream cover fetch and count calls, so a cached card can assert
 * the network was not touched again. */
function stubImageFetch(bytes: Buffer, contentType = "image/png") {
	const calls = { count: 0 };
	globalThis.fetch = (async () => {
		calls.count++;
		return {
			ok: true,
			status: 200,
			headers: {
				get: (h: string) =>
					h.toLowerCase() === "content-type" ? contentType : null,
			},
			arrayBuffer: async () =>
				bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return calls;
}

// A literal public IP so the SSRF guard skips the DNS lookup a hostname would
// need (it would hit the real resolver in tests).
const COVER_URL = "https://203.0.113.7/cover.png";

const solidPng = (w: number, h: number) =>
	sharp({
		create: {
			width: w,
			height: h,
			channels: 3,
			background: { r: 90, g: 40, b: 20 },
		},
	})
		.png()
		.toBuffer();

/** A published exhibition whose cover is a member artwork served from a remote
 * source URL. */
function publishedExhibitionRow(over: Partial<Row> = {}): Row {
	return {
		id: "exh-1",
		kind: "exhibition",
		name: "Impressionist Wing",
		tagline: "Light and colour",
		description: "A walk through late 19th-century painting.",
		theme: { wallColor: "#2b2016" },
		coverImageUrl: null,
		coverArtworkId: "art-1",
		isPublished: true,
		...over,
	};
}

function coverArtworkRow(over: Partial<Row> = {}): Row {
	return {
		imageUrl: COVER_URL,
		thumbnailUrl: null,
		isPublished: true,
		userId: "owner-1",
		primaryAssetId: null,
		...over,
	};
}

/** Wire the db mock for a card render: the exhibition row, one room, one
 * placement (also the cover artwork), and that artwork's source. */
function wireExhibition(exhibitionOver: Partial<Row> = {}) {
	rowsFor = (t) => {
		if (t === exhibition) return [publishedExhibitionRow(exhibitionOver)];
		if (t === room) return [{ id: "room-1" }];
		if (t === placement) return [{ artworkId: "art-1" }];
		if (t === artwork) return [coverArtworkRow()];
		return [];
	};
}

let uploadRoot: string;
let store: MediaStore;

async function metaOf(res: Response) {
	return sharp(Buffer.from(await res.arrayBuffer())).metadata();
}

beforeEach(async () => {
	uploadRoot = await mkdtemp(path.join(tmpdir(), "og-card-test-"));
	store = createDiskStore(uploadRoot);
	rowsFor = () => [];
});

afterEach(async () => {
	globalThis.fetch = realFetch;
	await rm(uploadRoot, { recursive: true, force: true });
});

describe("serveOgCard — compose and cache", () => {
	test("composes a 1200x630 png and caches it to disk", async () => {
		wireExhibition();
		stubImageFetch(await solidPng(600, 400));

		const res = await serveOgCard({ store, slug: "wing" });

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/png");
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
		const meta = await metaOf(res);
		expect(meta.format).toBe("png");
		expect(meta.width).toBe(1200);
		expect(meta.height).toBe(630);

		expect(await Bun.file(cardFile(uploadRoot, "exh-1")).exists()).toBe(true);
	});

	test("second request serves the cached card and revalidates to 304", async () => {
		wireExhibition();
		const calls = stubImageFetch(await solidPng(600, 400));

		const first = await serveOgCard({ store, slug: "wing" });
		expect(first.status).toBe(200);
		expect(calls.count).toBe(1);
		const etag = first.headers.get("ETag");
		expect(etag).toBeTruthy();

		const second = await serveOgCard({ store, slug: "wing" });
		expect(second.status).toBe(200);
		expect(second.headers.get("Content-Type")).toBe("image/png");
		// The disk cache answered — the cover was not fetched again.
		expect(calls.count).toBe(1);

		const revalidated = await serveOgCard({
			store,
			slug: "wing",
			ifNoneMatch: etag ?? undefined,
		});
		expect(revalidated.status).toBe(304);
		expect(calls.count).toBe(1);
	});

	test("renders without a cover when the entity has none", async () => {
		rowsFor = (t) => {
			if (t === exhibition)
				return [
					publishedExhibitionRow({ coverArtworkId: null, coverImageUrl: null }),
				];
			if (t === room) return [{ id: "room-1" }];
			if (t === placement) return [];
			return [];
		};
		const calls = stubImageFetch(await solidPng(600, 400));

		const res = await serveOgCard({ store, slug: "wing" });

		expect(res.status).toBe(200);
		const meta = await metaOf(res);
		expect(meta.width).toBe(1200);
		expect(meta.height).toBe(630);
		// No cover reference resolved, so no upstream fetch.
		expect(calls.count).toBe(0);
	});

	test("cover-ref present but fetch failed: serves coverless, caches nothing, retries next time", async () => {
		// Distinct per-phase IPs so the phase-1 failure's 10-minute negative cache
		// in public-image can't suppress the phase-2 retry.
		const failUrl = "https://203.0.113.20/cover.png";
		const okUrl = "https://203.0.113.21/cover.png";
		let coverUrl = failUrl;
		rowsFor = (t) => {
			if (t === exhibition) return [publishedExhibitionRow()];
			if (t === room) return [{ id: "room-1" }];
			if (t === placement) return [{ artworkId: "art-1" }];
			if (t === artwork) return [coverArtworkRow({ imageUrl: coverUrl })];
			return [];
		};

		// Phase 1: the cover exists but upstream fails. A 404 aborts the fetch
		// ladder immediately (a 5xx would burn the 2s/8s backoffs).
		globalThis.fetch = (async () => ({
			ok: false,
			status: 404,
			body: null,
			headers: { get: () => null },
		})) as unknown as typeof fetch;

		const failed = await serveOgCard({ store, slug: "wing" });
		expect(failed.status).toBe(200);
		expect(failed.headers.get("Cache-Control")).toBe("no-store");
		const failedMeta = await metaOf(failed);
		expect(failedMeta.width).toBe(1200);
		expect(failedMeta.height).toBe(630);
		const cacheFile = cardFile(uploadRoot, "exh-1");
		// A transient cover failure must not freeze a coverless card in the cache.
		expect(await Bun.file(cacheFile).exists()).toBe(false);

		// Phase 2: the cover is fetchable again, so the card caches with it.
		coverUrl = okUrl;
		const calls = stubImageFetch(await solidPng(600, 400));
		const ok = await serveOgCard({ store, slug: "wing" });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("Cache-Control")).toBe("public, max-age=3600");
		expect(calls.count).toBe(1);
		expect(await Bun.file(cacheFile).exists()).toBe(true);
	});
});

describe("serveOgCard — publish gate", () => {
	test("404s for an unpublished exhibition and writes no card", async () => {
		wireExhibition({ isPublished: false });
		const calls = stubImageFetch(await solidPng(600, 400));

		const res = await serveOgCard({ store, slug: "wing" });

		expect(res.status).toBe(404);
		expect(calls.count).toBe(0);
		expect(await Bun.file(cardFile(uploadRoot, "exh-1")).exists()).toBe(false);
	});

	test("404s for a personal collection even when flagged published", async () => {
		wireExhibition({ kind: "personal", isPublished: true });
		const calls = stubImageFetch(await solidPng(600, 400));

		const res = await serveOgCard({ store, slug: "wing" });

		expect(res.status).toBe(404);
		expect(calls.count).toBe(0);
	});

	test("404s for a missing exhibition", async () => {
		rowsFor = () => [];
		const res = await serveOgCard({ store, slug: "nope" });
		expect(res.status).toBe(404);
	});
});

describe("deleteEntityCacheFiles — card invalidation", () => {
	test("purges the cached card so the next share re-derives it", async () => {
		wireExhibition();
		stubImageFetch(await solidPng(600, 400));

		await serveOgCard({ store, slug: "wing" });
		const cacheFile = cardFile(uploadRoot, "exh-1");
		expect(await Bun.file(cacheFile).exists()).toBe(true);

		await deleteEntityCacheFiles({
			store,
			entity: "exhibition",
			id: "exh-1",
		});

		expect(await Bun.file(cacheFile).exists()).toBe(false);
	});
});

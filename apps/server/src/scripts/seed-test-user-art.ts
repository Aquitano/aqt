/** Seeds the test user's archive with a couple of stored artworks so the
 * studio hang/reorder flow can be exercised. Images are downloaded once and
 * stored locally via the normal import path — no external URL is kept, so
 * this mirrors how a real user adds art. Safe to re-run (idempotent by
 * title for the test user).
 *
 * Run from the repo root: bun apps/server/src/scripts/seed-test-user-art.ts
 */
import path from "node:path";
import { db } from "@aqt-gallery/db";
import { user } from "@aqt-gallery/db/schema/auth";
import { artwork } from "@aqt-gallery/db/schema/gallery";
import { env } from "@aqt-gallery/env/server";
import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import { importMediaFromUrls, uploadErrorResponse } from "../media/upload";

const EMAIL = "test@me3.com";

const SEED = [
	{
		title: "The Olive Trees",
		artist: "Vincent van Gogh",
		year: "1889",
		dimensions: "73.7 × 92.1 cm",
		url: "https://commons.wikimedia.org/wiki/Special:FilePath/Vincent%20van%20Gogh%20-%20The%20Olive%20Trees%20-%20Google%20Art%20Project.jpg?width=1600",
	},
	{
		title: "Wheat Field with Cypresses",
		artist: "Vincent van Gogh",
		year: "1889",
		dimensions: "73 × 93.4 cm",
		url: "https://commons.wikimedia.org/wiki/Special:FilePath/Vincent%20Willem%20van%20Gogh%20128.jpg?width=1600",
	},
] as const;

const rows = await db.select().from(user).where(eq(user.email, EMAIL)).limit(1);
const u = rows[0];
if (!u) {
	throw new Error(`No user with email ${EMAIL}`);
}

// Idempotent: drop previously seeded artworks (cascades their media assets).
await db.delete(artwork).where(
	and(
		eq(artwork.userId, u.id),
		inArray(
			artwork.title,
			SEED.map((s) => s.title),
		),
	),
);

const result = await Effect.runPromise(
	importMediaFromUrls({
		items: SEED.map((s) => ({ url: s.url, title: s.title })),
		uploadRoot: path.resolve(env.UPLOAD_DIR),
		userId: u.id,
	}).pipe(
		Effect.match({
			onFailure: (error) => ({
				ok: false as const,
				error: uploadErrorResponse(error).body.error,
			}),
			onSuccess: (uploaded) => ({ ok: true as const, uploaded }),
		}),
	),
);

if (!result.ok) {
	throw new Error(`Seed import failed: ${result.error}`);
}

// Enrich the freshly imported artworks with curated metadata so the 3D
// layout has real physical dimensions to size frames from.
for (const item of result.uploaded) {
	const meta = SEED.find((s) => s.title === item.title);
	if (!meta) continue;
	await db
		.update(artwork)
		.set({
			artist: meta.artist,
			artworkType: "painting",
			year: meta.year,
			dimensions: meta.dimensions,
		})
		.where(eq(artwork.id, item.artworkId));
}

console.log(
	`seeded ${result.uploaded.length} stored test artworks for ${u.id}`,
);
process.exit(0);

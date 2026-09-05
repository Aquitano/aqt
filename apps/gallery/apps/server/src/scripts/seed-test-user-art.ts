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
import { artwork } from "@aqt-gallery/db/schema/gallery";
import { env } from "@aqt-gallery/env/server";
import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import { importMediaFromUrls, uploadErrorResponse } from "../media/upload";

// Clerk user id to seed for (e.g. "user_2 abc…"). Identities live in Clerk now,
// so there is no local user table to look up by email.
const SEED_USER_ID = process.env.SEED_USER_ID;
if (!SEED_USER_ID) {
	throw new Error("Set SEED_USER_ID to the Clerk user id to seed for");
}

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

// Idempotent: drop previously seeded artworks (cascades their media assets).
await db.delete(artwork).where(
	and(
		eq(artwork.userId, SEED_USER_ID),
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
		userId: SEED_USER_ID,
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
	`seeded ${result.uploaded.length} stored test artworks for ${SEED_USER_ID}`,
);
process.exit(0);

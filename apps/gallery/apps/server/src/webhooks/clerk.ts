import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@aqt-gallery/db";
import { exhibition } from "@aqt-gallery/db/schema/exhibition";
import { artist, artwork, tag } from "@aqt-gallery/db/schema/gallery";
import { apiToken } from "@aqt-gallery/db/schema/tokens";
import { eq } from "drizzle-orm";
import { deleteEntityCacheFiles } from "../media/delete-files";
import { publicImageCacheTargets } from "../media/public-image";
import type { MediaStore } from "../media/store";

/** Reject webhooks whose signed timestamp is older/newer than this, to blunt
 * replay of a captured request. */
const SVIX_TOLERANCE_MS = 5 * 60_000;

export type SvixHeaders = {
	id: string | undefined;
	timestamp: string | undefined;
	signature: string | undefined;
};

/**
 * Verify a Clerk webhook signature. Clerk signs with svix, so we reproduce the
 * svix scheme directly (no SDK dependency): the signed content is
 * `${id}.${timestamp}.${body}`, the secret is `whsec_<base64>`, and the
 * `svix-signature` header is a space-separated list of `v<n>,<base64-hmac>`
 * entries. We accept the request if any `v1` entry matches an HMAC-SHA256 of
 * the signed content under the (base64-decoded) secret.
 */
export function verifyClerkWebhook(
	secret: string,
	headers: SvixHeaders,
	body: string,
): boolean {
	const { id, timestamp, signature } = headers;
	if (!id || !timestamp || !signature) return false;

	const ts = Number(timestamp);
	if (!Number.isFinite(ts)) return false;
	if (Math.abs(Date.now() - ts * 1000) > SVIX_TOLERANCE_MS) return false;

	const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
	const expected = createHmac("sha256", key)
		.update(`${id}.${timestamp}.${body}`)
		.digest();

	return signature.split(" ").some((part) => {
		const [version, value] = part.split(",");
		if (version !== "v1" || !value) return false;
		let provided: Buffer;
		try {
			provided = Buffer.from(value, "base64");
		} catch {
			return false;
		}
		return (
			provided.length === expected.length && timingSafeEqual(provided, expected)
		);
	});
}

async function bestEffortDelete(store: MediaStore, key: string) {
	await store.delete(key).catch(() => {
		/* object already gone or unreachable — cleanup is best-effort */
	});
}

export type PurgeResult = {
	artworks: number;
	exhibitions: number;
	artists: number;
	tags: number;
	tokens: number;
};

/**
 * Remove everything a now-deleted Clerk user owns. Identities live in Clerk,
 * not in this database, so nothing cascades when an account is deleted there —
 * without this, a deleted user's published exhibitions stay publicly walkable
 * forever. Artworks cascade to their media assets, custom fields, tag links
 * and placements; the remaining owned rows are deleted explicitly. Stored
 * media is cleaned best-effort after the rows are gone.
 */
export async function purgeUserData(
	userId: string,
	store: MediaStore,
): Promise<PurgeResult> {
	// Capture artwork ids up front — needed to clear the per-artwork public
	// image cache after the rows (and their keys) are gone.
	const ownArtworks = await db
		.select({ id: artwork.id })
		.from(artwork)
		.where(eq(artwork.userId, userId));

	const result = await db.transaction(async (tx) => {
		// Cascades: media_asset, artwork_custom_field, artwork_tag, placement.
		const arts = await tx
			.delete(artwork)
			.where(eq(artwork.userId, userId))
			.returning({ id: artwork.id });
		const exhibitions = await tx
			.delete(exhibition)
			.where(eq(exhibition.createdBy, userId))
			.returning({ id: exhibition.id });
		const artists = await tx
			.delete(artist)
			.where(eq(artist.userId, userId))
			.returning({ id: artist.id });
		const tags = await tx
			.delete(tag)
			.where(eq(tag.userId, userId))
			.returning({ id: tag.id });
		const tokens = await tx
			.delete(apiToken)
			.where(eq(apiToken.userId, userId))
			.returning({ id: apiToken.id });
		return {
			artworks: arts.length,
			exhibitionIds: exhibitions.map((e) => e.id),
			artists: artists.length,
			tags: tags.length,
			tokens: tokens.length,
		};
	});

	// Best-effort storage cleanup — never let a storage error fail the webhook
	// (Clerk would retry, but the DB rows are already gone).
	await store.deletePrefix(`originals/${userId}/`).catch(() => {});
	await store.deletePrefix(`thumbs/${userId}/`).catch(() => {});

	// Purge each artwork's cached public imagery via the shared key helper, so
	// this stays in lockstep with the cache scheme (every variant, extension,
	// and cache-scheme version) instead of hand-rolling the names here. Deleted
	// in bounded-concurrency batches rather than serially: a user with thousands
	// of artworks would otherwise block the webhook response long enough for
	// Clerk to time out and retry the whole purge.
	const cacheKeys = ownArtworks.flatMap(({ id }) =>
		publicImageCacheTargets("artwork", id),
	);
	const DELETE_CONCURRENCY = 64;
	for (let i = 0; i < cacheKeys.length; i += DELETE_CONCURRENCY) {
		await Promise.all(
			cacheKeys
				.slice(i, i + DELETE_CONCURRENCY)
				.map((key) => bestEffortDelete(store, key)),
		);
	}

	for (const id of result.exhibitionIds) {
		await deleteEntityCacheFiles({ store, entity: "exhibition", id });
	}

	const { exhibitionIds, ...counts } = result;
	return { ...counts, exhibitions: exhibitionIds.length };
}

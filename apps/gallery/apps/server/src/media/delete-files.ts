import { ogCardCacheTargets } from "./og-card";
import { publicImageCacheTargets } from "./public-image";
import type { MediaStore } from "./store";

/**
 * Removes the stored artefacts a database delete leaves behind. The FK
 * cascades clear the rows; nothing else removes the originals, thumbnails, or
 * proxied-image cache, so without this every deleted artwork would keep its
 * pixels in storage forever (unbounded growth, and deleted images persisting
 * past a retention/privacy expectation).
 */

/** Remove an object, treating "already gone" as success. Any other error
 * (permissions, I/O, an unreachable bucket) is logged but never thrown: the DB
 * rows are already deleted, so failing the request would not help the caller —
 * it would just make a successful delete look broken. The log is what surfaces
 * a real storage fault (the very thing that would otherwise reintroduce the
 * leak). */
async function bestEffortDelete(store: MediaStore, key: string): Promise<void> {
	try {
		await store.delete(key);
	} catch (error) {
		console.error(`Failed to remove media object ${key}:`, error);
	}
}

/** Purge every stored artefact tied to a deleted artwork: its media asset
 * originals/thumbnails (keys read before the cascade) and any cached proxied
 * images keyed by the artwork id. */
export async function deleteArtworkFiles(opts: {
	store: MediaStore;
	artworkId: string;
	assetKeys: ReadonlyArray<string>;
}): Promise<void> {
	const targets = [
		...opts.assetKeys,
		...publicImageCacheTargets("artwork", opts.artworkId),
	];
	await Promise.all(targets.map((key) => bestEffortDelete(opts.store, key)));
}

/** Purge only an artwork's cached proxied images, leaving its stored asset
 * originals/thumbnails intact. Used when the artwork keeps its files but the
 * image it serves changes (e.g. swapping the primary asset), so the capped-webp
 * cache — keyed by artwork id, not asset id — must be re-derived. */
export async function deleteArtworkCacheFiles(opts: {
	store: MediaStore;
	artworkId: string;
}): Promise<void> {
	await Promise.all(
		publicImageCacheTargets("artwork", opts.artworkId).map((key) =>
			bestEffortDelete(opts.store, key),
		),
	);
}

/** Purge the cached cover image and social card of a deleted exhibition.
 * Member artworks survive the delete, so only the entity's own cache is
 * removed. */
export async function deleteEntityCacheFiles(opts: {
	store: MediaStore;
	entity: "exhibition";
	id: string;
}): Promise<void> {
	const targets = [
		...publicImageCacheTargets(opts.entity, opts.id),
		...ogCardCacheTargets(opts.id),
	];
	await Promise.all(targets.map((key) => bestEffortDelete(opts.store, key)));
}

/** Purge only an entity's cached social card, leaving its cover image cache
 * intact. Used when the card's inputs change but the cover proxy doesn't — an
 * edit to the name/tagline/theme/counts, a cover swap, or an unpublish — so the
 * next share re-derives a fresh card instead of serving the immutable old one. */
export async function deleteOgCardFiles(opts: {
	store: MediaStore;
	entity: "exhibition";
	id: string;
}): Promise<void> {
	await Promise.all(
		ogCardCacheTargets(opts.id).map((key) => bestEffortDelete(opts.store, key)),
	);
}

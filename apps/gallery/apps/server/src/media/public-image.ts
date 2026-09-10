import { db } from "@aqt-gallery/db";
import { exhibition } from "@aqt-gallery/db/schema/exhibition";
import { artwork, mediaAsset } from "@aqt-gallery/db/schema/gallery";
import { eq } from "drizzle-orm";
import sharp from "sharp";

import { mediaKey } from "./paths";
import { fetchFollowingRedirects, readImageBodyCapped } from "./ssrf-fetch";
import type { MediaStore } from "./store";

/** Cap on the bytes buffered from an upstream cache-miss fetch. Mirrors the
 * upload/import ceiling so a single (possibly length-lying) source can't pin
 * unbounded memory or fill storage on the anonymous serve path. */
const MAX_UPSTREAM_BYTES = 25 * 1024 * 1024;

/**
 * Serves exhibition imagery to the browser from our own backend.
 *
 * The database stores *source* URLs (e.g. Wikimedia Commons open-access
 * files). On first request the server downloads the image into the media
 * store; afterwards it streams straight from there. The browser only ever
 * talks to this API — no third-party hotlinking, and WebGL texture CORS
 * is handled by our own CORS middleware.
 *
 * Published artworks without an external source URL (user uploads) are
 * served straight from their stored primary media asset instead.
 */

const ENTITIES = ["artwork", "exhibition"] as const;
type Entity = (typeof ENTITIES)[number];

const VARIANTS = ["full", "mid", "thumb", "cover"] as const;
type Variant = (typeof VARIANTS)[number];

const EXT_BY_TYPE: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
};

/** Where an image comes from: a remote source URL (proxied + cached) or an
 * object already in the store (user-uploaded media asset). `isPublic` is false
 * only for an owner previewing their own unpublished artwork — those must never
 * land in a shared/CDN cache, so they get private, non-immutable headers. */
type ImageSource =
	| { kind: "remote"; url: string; isPublic: boolean }
	| { kind: "local"; key: string; contentType: string; isPublic: boolean };

async function sourceFor(
	entity: Entity,
	id: string,
	variant: Variant,
	resolveViewer?: () => Promise<string | undefined>,
): Promise<ImageSource | null> {
	if (entity === "artwork") {
		const rows = await db
			.select({
				imageUrl: artwork.imageUrl,
				thumbnailUrl: artwork.thumbnailUrl,
				isPublished: artwork.isPublished,
				userId: artwork.userId,
				primaryAssetId: artwork.primaryAssetId,
			})
			.from(artwork)
			.where(eq(artwork.id, id))
			.limit(1);
		const row = rows[0];
		if (!row) return null;
		// Published artworks are public. An owner may also view their own
		// unpublished artwork — the private archive and studio grids serve
		// thumbnails through this same proxy. The session lookup is lazy so the
		// public exhibition hot path (published images) never pays for it.
		if (!row.isPublished) {
			const viewerId = await resolveViewer?.();
			if (!viewerId || row.userId !== viewerId) return null;
		}
		const isPublic = row.isPublished;
		const url =
			variant === "thumb" ? (row.thumbnailUrl ?? row.imageUrl) : row.imageUrl;
		if (url) {
			return { kind: "remote", url, isPublic };
		}
		if (!row.primaryAssetId) return null;
		const assets = await db
			.select({
				storagePath: mediaAsset.storagePath,
				thumbnailPath: mediaAsset.thumbnailPath,
				mimeType: mediaAsset.mimeType,
			})
			.from(mediaAsset)
			.where(eq(mediaAsset.id, row.primaryAssetId))
			.limit(1);
		const asset = assets[0];
		if (!asset) return null;
		return variant === "thumb"
			? {
					kind: "local",
					key: mediaKey(asset.thumbnailPath),
					contentType: "image/webp",
					isPublic,
				}
			: {
					kind: "local",
					key: mediaKey(asset.storagePath),
					contentType: asset.mimeType,
					isPublic,
				};
	}
	// Exhibition covers carry their own publish flag: an unpublished draft's
	// cover must not leak to anonymous viewers, and only the owner may preview
	// it (and never via a shared/immutable cache). Mirrors the artwork gate.
	const rows = await db
		.select({
			coverImageUrl: exhibition.coverImageUrl,
			isPublished: exhibition.isPublished,
			createdBy: exhibition.createdBy,
		})
		.from(exhibition)
		.where(eq(exhibition.id, id))
		.limit(1);
	const row = rows[0];
	if (!row?.coverImageUrl) return null;
	if (!row.isPublished) {
		const viewerId = await resolveViewer?.();
		if (!viewerId || row.createdBy !== viewerId) return null;
	}
	return { kind: "remote", url: row.coverImageUrl, isPublic: row.isPublished };
}

/** Published imagery is content-stable per (entity, id, variant) and served
 * from our cache, so it gets a year-long immutable cache plus an ETag for CDN
 * revalidation. An owner's unpublished preview stays private and revalidates. */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const PRIVATE_CACHE_CONTROL = "private, max-age=0, must-revalidate";

function cacheControlFor(isPublic: boolean): string {
	return isPublic ? IMMUTABLE_CACHE_CONTROL : PRIVATE_CACHE_CONTROL;
}

function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
	if (!ifNoneMatch) return false;
	// RFC 7232: `*` matches any current representation.
	if (ifNoneMatch.trim() === "*") return true;
	return ifNoneMatch
		.split(",")
		.some((tag) => tag.trim() === etag || tag.trim() === `W/${etag}`);
}

/** Serve a stored image with validators, or null if the object is absent.
 * Answers 304 when the client's `If-None-Match` already holds the current
 * bytes, so a revalidating CDN/browser skips the body. */
export async function serveStoredImage(options: {
	store: MediaStore;
	key: string;
	contentType: string;
	cacheControl: string;
	ifNoneMatch?: string;
}): Promise<Response | null> {
	const object = await options.store.get(options.key);
	if (!object) return null;
	const headers = {
		"Content-Type": options.contentType,
		"Cache-Control": options.cacheControl,
		"X-Content-Type-Options": "nosniff",
		ETag: object.etag,
	};
	if (etagMatches(options.ifNoneMatch, object.etag)) {
		// The body is never read on a 304; releasing it keeps the backend from
		// holding an open file handle / socket for the rest of the process.
		await object.stream.cancel();
		return new Response(null, { status: 304, headers });
	}
	return new Response(object.stream, {
		headers: { ...headers, "Content-Length": String(object.size) },
	});
}

function serveCached(
	store: MediaStore,
	key: string,
	contentType: string,
	isPublic: boolean,
	ifNoneMatch: string | undefined,
): Promise<Response | null> {
	return serveStoredImage({
		store,
		key,
		contentType,
		cacheControl: cacheControlFor(isPublic),
		ifNoneMatch,
	});
}

export function isEntity(value: string): value is Entity {
	return (ENTITIES as readonly string[]).includes(value);
}

export function isVariant(value: string): value is Variant {
	return (VARIANTS as readonly string[]).includes(value);
}

/** Bumped whenever the cached encoding changes so stale files are re-derived
 * instead of served. v1 (unversioned) cached verbatim source bytes; v2 caps
 * imagery to <=2048px webp so a single WebGL texture upload stays bounded. */
const CACHE_VERSION = "v2";

/** The cache key for one entity image, sans extension:
 * `public-image-cache/<entity>-<safeId>-<variant>-<version>`. The id is
 * sanitised so a crafted id can never escape the cache prefix. This is the
 * single source of truth for the cache key — both the serve path below and the
 * cleanup-on-delete path derive from it, so they can never drift apart.
 * `version` defaults to the current scheme; the purge path passes older ones so
 * a re-encode leaves nothing behind. */
function cacheBaseFor(
	entity: Entity,
	id: string,
	variant: Variant,
	version: string = CACHE_VERSION,
): string {
	const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	const suffix = version ? `-${version}` : "";
	return `public-image-cache/${entity}-${safeId}-${variant}${suffix}`;
}

/** Every cache key that could exist for an entity's image, across all variants,
 * content types, and cache-scheme versions (current + legacy). Used to purge
 * the cache when the entity is deleted, so removed images — including ones
 * written under an older scheme — don't linger in storage forever. */
export function publicImageCacheTargets(entity: Entity, id: string): string[] {
	const exts = Object.values(EXT_BY_TYPE);
	const versions = [CACHE_VERSION, ""]; // current, then legacy unversioned
	return VARIANTS.flatMap((variant) =>
		versions.flatMap((version) =>
			exts.map((ext) => `${cacheBaseFor(entity, id, variant, version)}.${ext}`),
		),
	);
}

/** Upstream fetches are deduped per source URL and limited to a small
 * concurrency — image hosts (e.g. Wikimedia) rate-limit hard bursts, but
 * a fully serial queue stalls a cold room load past the HTTP timeout.
 * Cache misses are a one-time cost per image; afterwards everything is
 * served from the store. */
type UpstreamImage = { bytes: Buffer; contentType: string };

const MAX_UPSTREAM_CONCURRENCY = 2;
let activeUpstream = 0;
const upstreamWaiters: Array<() => void> = [];
const inflightByUrl = new Map<string, Promise<UpstreamImage | null>>();

const UPSTREAM_USER_AGENT = "aqt-gallery/1.0 (exhibition image cache)";

/** Failed upstream fetches are negative-cached briefly. A dead or undecodable
 * source is never written to the cache, so without this every cold
 * request would re-run the full retry ladder (2s/8s backoffs) through the
 * shared 2-slot semaphore — burning upstream budget and stalling other
 * paintings' cache misses behind a URL that is known to be bad. */
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const failedUntilByUrl = new Map<string, number>();

function noteUpstreamFailure(url: string) {
	const now = Date.now();
	for (const [key, expiry] of failedUntilByUrl) {
		if (expiry <= now) failedUntilByUrl.delete(key);
	}
	failedUntilByUrl.set(url, now + NEGATIVE_CACHE_TTL_MS);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withUpstreamSlot<T>(work: () => Promise<T>): Promise<T> {
	// A woken waiter inherits the releaser's slot instead of re-counting after
	// wakeup: resolving its promise only schedules a microtask, so re-doing
	// `activeUpstream++` there would let the count transiently dip and admit an
	// extra concurrent fetch past the cap.
	if (activeUpstream >= MAX_UPSTREAM_CONCURRENCY) {
		await new Promise<void>((resolve) => upstreamWaiters.push(resolve));
	} else {
		activeUpstream++;
	}
	try {
		return await work();
	} finally {
		const next = upstreamWaiters.shift();
		if (next) {
			next();
		} else {
			activeUpstream--;
		}
	}
}

function fetchUpstream(url: string): Promise<UpstreamImage | null> {
	const existing = inflightByUrl.get(url);
	if (existing) return existing;
	const failedUntil = failedUntilByUrl.get(url);
	if (failedUntil !== undefined) {
		if (failedUntil > Date.now()) return Promise.resolve(null);
		failedUntilByUrl.delete(url);
	}
	const task = (async () => {
		for (const delayMs of [0, 2000, 8000]) {
			if (delayMs > 0) await sleep(delayMs);
			try {
				// Hold the concurrency slot only around the network call, not the
				// backoff sleeps — otherwise one throttled URL blocks every other
				// cold-room fetch for the whole retry sequence.
				const res = await withUpstreamSlot(() =>
					fetchFollowingRedirects(url, { userAgent: UPSTREAM_USER_AGENT }),
				);
				if (res.ok) {
					const contentType =
						res.headers
							.get("content-type")
							?.split(";")[0]
							?.trim()
							.toLowerCase() ?? "";
					// Only persist a confirmed, supported, non-empty image. A 200 with
					// an HTML error page, empty body, or unknown type would otherwise be
					// cached as immutable and served forever with no self-heal path.
					if (!EXT_BY_TYPE[contentType]) {
						await res.body?.cancel();
						return null;
					}
					const bytes = await readImageBodyCapped(res, MAX_UPSTREAM_BYTES);
					if (!bytes || bytes.byteLength === 0) return null;
					return { bytes, contentType };
				}
				if (res.status === 429) {
					const retryAfter = Number(res.headers.get("retry-after"));
					await res.body?.cancel();
					if (Number.isFinite(retryAfter) && retryAfter > 0) {
						await sleep(Math.min(retryAfter, 15) * 1000);
					}
					continue;
				}
				await res.body?.cancel();
				if (res.status < 500) return null;
			} catch {
				// transient network failure or SSRF rejection — retry/abort
			}
		}
		return null;
	})()
		.then((result) => {
			if (result === null) noteUpstreamFailure(url);
			return result;
		})
		.finally(() => {
			inflightByUrl.delete(url);
		});
	inflightByUrl.set(url, task);
	return task;
}

/** The largest dimension we serve per variant. Above 2048px a single GPU
 * texture upload becomes a multi-hundred-ms stall, so cap at the cache boundary
 * rather than shipping originals. `mid` is the renderer's streaming tier
 * between the thumbnail and the full-res canvas. A local `thumb` streams its
 * stored thumbnail untouched; a remote one has no stored file and would
 * otherwise re-encode the full-size source, so it is capped small. */
const MAX_DIMENSION_BY_VARIANT = {
	full: 2048,
	cover: 2048,
	mid: 1024,
	thumb: 480,
} satisfies Record<Variant, number>;
const WEBP_QUALITY = 82;

/** Downscale oversized imagery to a <=maxDimension webp for caching. `.rotate()`
 * bakes EXIF orientation in before sharp strips metadata, so re-encoded photos
 * aren't left sideways. Returns null when sharp can't decode the input, so
 * callers fall back to the untouched original (serving something beats a 500). */
async function encodeCapped(
	input: Buffer,
	maxDimension: number,
): Promise<Buffer | null> {
	try {
		return await sharp(input)
			.rotate()
			.resize({
				width: maxDimension,
				height: maxDimension,
				fit: "inside",
				withoutEnlargement: true,
			})
			.webp({ quality: WEBP_QUALITY })
			.toBuffer();
	} catch {
		return null;
	}
}

type CachedImage = { key: string; contentType: string };

async function readStored(
	store: MediaStore,
	key: string,
): Promise<Buffer | null> {
	const object = await store.get(key);
	if (!object) return null;
	return Buffer.from(await new Response(object.stream).arrayBuffer());
}

/** The capped webp of a stored original for `variant`, derived on first use.
 * A stored original is variant-independent (full and cover resolve to the same
 * object), so their copies share the "full" key; every variant that caps
 * to a different size gets its own. Null when sharp can't decode the source. */
async function ensureLocalCapped(
	store: MediaStore,
	entity: Entity,
	id: string,
	variant: Variant,
	source: Extract<ImageSource, { kind: "local" }>,
): Promise<CachedImage | null> {
	const cacheVariant = variant === "cover" ? "full" : variant;
	const key = `${cacheBaseFor(entity, id, cacheVariant)}.webp`;
	const cached: CachedImage = { key, contentType: "image/webp" };
	if (await store.head(key)) return cached;
	const original = await readStored(store, source.key);
	if (!original) return null;
	const capped = await encodeCapped(
		original,
		MAX_DIMENSION_BY_VARIANT[variant],
	);
	if (!capped) return null;
	await store.put(key, capped, "image/webp");
	return cached;
}

/** The cached copy of a remote source, if any (the extension records the
 * content type). */
async function findRemoteCached(
	store: MediaStore,
	cacheBase: string,
): Promise<CachedImage | null> {
	for (const [contentType, ext] of Object.entries(EXT_BY_TYPE)) {
		const key = `${cacheBase}.${ext}`;
		if (await store.head(key)) return { key, contentType };
	}
	return null;
}

/** Fetch a remote source, cap it to the variant's size and cache it. Animated
 * GIFs and anything sharp can't decode are cached as the verbatim upstream
 * bytes. Null when upstream is unavailable. */
async function ensureRemoteCached(
	store: MediaStore,
	cacheBase: string,
	source: Extract<ImageSource, { kind: "remote" }>,
	variant: Variant,
): Promise<CachedImage | null> {
	const cached = await findRemoteCached(store, cacheBase);
	if (cached) return cached;
	const upstream = await fetchUpstream(source.url);
	if (!upstream) return null;

	let body: Uint8Array | Buffer = upstream.bytes;
	let contentType = upstream.contentType;
	if (contentType !== "image/gif") {
		const capped = await encodeCapped(
			upstream.bytes,
			MAX_DIMENSION_BY_VARIANT[variant],
		);
		if (capped) {
			body = capped;
			contentType = "image/webp";
		}
	}
	// Only cache under an extension that faithfully records the content type:
	// a later hit re-derives the type from the extension. fetchUpstream only
	// admits types in EXT_BY_TYPE, so this always resolves.
	const ext = EXT_BY_TYPE[contentType];
	if (!ext) return null;
	const key = `${cacheBase}.${ext}`;
	await store.put(key, body, contentType);
	return { key, contentType };
}

/** Derive an artwork's streaming variants ahead of its first visitor, so a
 * cold exhibition load never pays a resize (or an upstream fetch) per painting.
 * Best-effort: failures are logged and the next request re-derives. Runs the
 * artworks one after another so a batch import doesn't fan out into dozens of
 * concurrent encodes. */
export async function warmArtworkImages(opts: {
	store: MediaStore;
	ownerId: string;
	artworkIds: readonly string[];
}): Promise<void> {
	const viewer = async () => opts.ownerId;
	for (const id of opts.artworkIds) {
		for (const variant of ["mid", "full"] as const) {
			try {
				const source = await sourceFor("artwork", id, variant, viewer);
				if (!source) continue;
				if (source.kind === "local") {
					await ensureLocalCapped(opts.store, "artwork", id, variant, source);
				} else {
					await ensureRemoteCached(
						opts.store,
						cacheBaseFor("artwork", id, variant),
						source,
						variant,
					);
				}
			} catch (error) {
				console.warn(`image warm-up failed for ${id}/${variant}`, error);
			}
		}
	}
}

// User uploads are already in the store. Thumbnails (already a small webp) and
// animated GIFs stream straight through; the full-res original is capped once
// into the shared cache and served from there afterwards. The stored original
// is never touched — it's the archival copy.
async function serveLocalImage(options: {
	store: MediaStore;
	entity: Entity;
	id: string;
	variant: Variant;
	source: Extract<ImageSource, { kind: "local" }>;
	ifNoneMatch?: string;
}): Promise<Response> {
	const { store, entity, id, variant, source, ifNoneMatch } = options;

	if (variant === "thumb" || source.contentType === "image/gif") {
		const response = await serveCached(
			store,
			source.key,
			source.contentType,
			source.isPublic,
			ifNoneMatch,
		);
		return response ?? new Response("Not found", { status: 404 });
	}

	// The access check already ran in sourceFor, so an unpublished owner
	// preview stays gated even though the capped copy lives under the shared
	// cache prefix.
	const capped = await ensureLocalCapped(store, entity, id, variant, source);
	if (capped) {
		const response = await serveCached(
			store,
			capped.key,
			capped.contentType,
			source.isPublic,
			ifNoneMatch,
		);
		if (response) return response;
	}
	// sharp couldn't decode it — serve the untouched original, not a 404.
	const fallback = await serveCached(
		store,
		source.key,
		source.contentType,
		source.isPublic,
		ifNoneMatch,
	);
	return fallback ?? new Response("Not found", { status: 404 });
}

export async function servePublicImage(options: {
	store: MediaStore;
	entity: Entity;
	id: string;
	variant: Variant;
	/** The request's `If-None-Match`, for conditional 304 responses. */
	ifNoneMatch?: string;
	resolveViewer?: () => Promise<string | undefined>;
	/** Consulted only when the request would fetch a fresh image from upstream
	 * (cache miss on a remote source). Returning `ok: false` answers 429 instead
	 * of hitting the third-party host, so cache hits and local files are never
	 * rate-limited. */
	checkUpstreamBudget?: () => { ok: boolean; retryAfterMs: number };
}): Promise<Response> {
	const {
		store,
		entity,
		id,
		variant,
		ifNoneMatch,
		resolveViewer,
		checkUpstreamBudget,
	} = options;
	const cacheBase = cacheBaseFor(entity, id, variant);

	// Resolve the source first — it carries the publish/owner check, so an
	// unpublished artwork is never served, not even from the cache.
	const source = await sourceFor(entity, id, variant, resolveViewer);
	if (!source) {
		return new Response("Not found", { status: 404 });
	}

	if (source.kind === "local") {
		return serveLocalImage({
			store,
			entity,
			id,
			variant,
			source,
			ifNoneMatch,
		});
	}

	// Serve from the cache when present; a cache miss on a remote source is the
	// only path that hits a third party, so gate just that (cache hits and
	// stored files never pay the budget).
	let cached = await findRemoteCached(store, cacheBase);
	if (!cached) {
		if (checkUpstreamBudget) {
			const budget = checkUpstreamBudget();
			if (!budget.ok) {
				return new Response("Too many image requests", {
					status: 429,
					headers: {
						"Retry-After": String(Math.ceil(budget.retryAfterMs / 1000)),
					},
				});
			}
		}
		cached = await ensureRemoteCached(store, cacheBase, source, variant);
		if (!cached) {
			return new Response("Upstream image unavailable", { status: 502 });
		}
	}
	const response = await serveCached(
		store,
		cached.key,
		cached.contentType,
		source.isPublic,
		ifNoneMatch,
	);
	return response ?? new Response("Not found", { status: 404 });
}

import path from "node:path";
import { db } from "@aqt-gallery/db";
import { artwork, mediaAsset } from "@aqt-gallery/db/schema/gallery";
import { artGroup, museum } from "@aqt-gallery/db/schema/museum";
import { eq } from "drizzle-orm";

/**
 * Serves museum imagery to the browser from our own backend.
 *
 * The database stores *source* URLs (e.g. Wikimedia Commons open-access
 * files). On first request the server downloads the image into a disk
 * cache; afterwards it streams straight from disk. The browser only ever
 * talks to this API — no third-party hotlinking, and WebGL texture CORS
 * is handled by our own CORS middleware.
 *
 * Published artworks without an external source URL (user uploads) are
 * served straight from their primary media asset on disk instead.
 */

const ENTITIES = ["artwork", "museum", "group"] as const;
type Entity = (typeof ENTITIES)[number];

const VARIANTS = ["full", "thumb", "cover"] as const;
type Variant = (typeof VARIANTS)[number];

const EXT_BY_TYPE: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
};

/** Where an image comes from: a remote source URL (proxied + cached) or a
 * file already on disk (user-uploaded media asset). */
type ImageSource =
	| { kind: "remote"; url: string }
	| { kind: "local"; filePath: string; contentType: string };

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
		// public museum hot path (published images) never pays for it.
		if (!row.isPublished) {
			const viewerId = await resolveViewer?.();
			if (!viewerId || row.userId !== viewerId) return null;
		}
		const url =
			variant === "thumb" ? (row.thumbnailUrl ?? row.imageUrl) : row.imageUrl;
		if (url) {
			return { kind: "remote", url };
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
					filePath: asset.thumbnailPath,
					contentType: "image/webp",
				}
			: {
					kind: "local",
					filePath: asset.storagePath,
					contentType: asset.mimeType,
				};
	}
	if (entity === "museum") {
		const rows = await db
			.select({ coverImageUrl: museum.coverImageUrl })
			.from(museum)
			.where(eq(museum.id, id))
			.limit(1);
		const url = rows[0]?.coverImageUrl;
		return url ? { kind: "remote", url } : null;
	}
	const rows = await db
		.select({ coverImageUrl: artGroup.coverImageUrl })
		.from(artGroup)
		.where(eq(artGroup.id, id))
		.limit(1);
	const url = rows[0]?.coverImageUrl;
	return url ? { kind: "remote", url } : null;
}

export function isEntity(value: string): value is Entity {
	return (ENTITIES as readonly string[]).includes(value);
}

export function isVariant(value: string): value is Variant {
	return (VARIANTS as readonly string[]).includes(value);
}

/** The cache file base for one entity image, sans extension:
 * `<uploadRoot>/public-image-cache/<entity>-<safeId>-<variant>`. The id is
 * sanitised so a crafted id can never escape the cache directory. This is the
 * single source of truth for the cache path — both the serve path below and
 * the cleanup-on-delete path derive from it, so they can never drift apart. */
function cacheBaseFor(
	uploadRoot: string,
	entity: Entity,
	id: string,
	variant: Variant,
): string {
	const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return path.join(
		uploadRoot,
		"public-image-cache",
		`${entity}-${safeId}-${variant}`,
	);
}

/** Every cache file that could exist for an entity's image, across all
 * variants and stored content types. Used to purge the cache when the entity
 * is deleted, so removed images don't linger on disk forever. */
export function publicImageCacheTargets(
	uploadRoot: string,
	entity: Entity,
	id: string,
): string[] {
	const exts = Object.values(EXT_BY_TYPE);
	return VARIANTS.flatMap((variant) =>
		exts.map(
			(ext) => `${cacheBaseFor(uploadRoot, entity, id, variant)}.${ext}`,
		),
	);
}

/** Upstream fetches are deduped per source URL and limited to a small
 * concurrency — image hosts (e.g. Wikimedia) rate-limit hard bursts, but
 * a fully serial queue stalls a cold room load past the HTTP timeout.
 * Cache misses are a one-time cost per image; afterwards everything is
 * served from disk. */
type UpstreamImage = { bytes: ArrayBuffer; contentType: string };

const MAX_UPSTREAM_CONCURRENCY = 2;
let activeUpstream = 0;
const upstreamWaiters: Array<() => void> = [];
const inflightByUrl = new Map<string, Promise<UpstreamImage | null>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withUpstreamSlot<T>(work: () => Promise<T>): Promise<T> {
	if (activeUpstream >= MAX_UPSTREAM_CONCURRENCY) {
		await new Promise<void>((resolve) => upstreamWaiters.push(resolve));
	}
	activeUpstream++;
	try {
		return await work();
	} finally {
		activeUpstream--;
		upstreamWaiters.shift()?.();
	}
}

function fetchUpstream(url: string): Promise<UpstreamImage | null> {
	const existing = inflightByUrl.get(url);
	if (existing) return existing;
	const task = withUpstreamSlot(async () => {
		for (const delayMs of [0, 2000, 8000]) {
			if (delayMs > 0) await sleep(delayMs);
			try {
				const res = await fetch(url, {
					headers: { "User-Agent": "aqt-gallery/1.0 (museum image cache)" },
					redirect: "follow",
				});
				if (res.ok) {
					const contentType =
						res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
					return { bytes: await res.arrayBuffer(), contentType };
				}
				if (res.status === 429) {
					const retryAfter = Number(res.headers.get("retry-after"));
					if (Number.isFinite(retryAfter) && retryAfter > 0) {
						await sleep(Math.min(retryAfter, 15) * 1000);
					}
					continue;
				}
				if (res.status < 500) return null;
			} catch {
				// transient network failure — retry
			}
		}
		return null;
	}).finally(() => {
		inflightByUrl.delete(url);
	});
	inflightByUrl.set(url, task);
	return task;
}

export async function servePublicImage(options: {
	uploadRoot: string;
	entity: Entity;
	id: string;
	variant: Variant;
	resolveViewer?: () => Promise<string | undefined>;
}): Promise<Response> {
	const { uploadRoot, entity, id, variant, resolveViewer } = options;
	const cacheBase = cacheBaseFor(uploadRoot, entity, id, variant);

	// Resolve the source first — it carries the publish/owner check, so an
	// unpublished artwork is never served, not even from the disk cache.
	const source = await sourceFor(entity, id, variant, resolveViewer);
	if (!source) {
		return new Response("Not found", { status: 404 });
	}

	// User uploads already live on disk — stream them directly.
	if (source.kind === "local") {
		const file = Bun.file(source.filePath);
		if (!(await file.exists())) {
			return new Response("Not found", { status: 404 });
		}
		return new Response(file.stream(), {
			headers: {
				"Content-Type": source.contentType,
				"Cache-Control": "public, max-age=86400",
			},
		});
	}

	// Serve from disk cache when present (extension records content type).
	for (const [type, ext] of Object.entries(EXT_BY_TYPE)) {
		const file = Bun.file(`${cacheBase}.${ext}`);
		if (await file.exists()) {
			return new Response(file.stream(), {
				headers: {
					"Content-Type": type,
					"Cache-Control": "public, max-age=86400",
				},
			});
		}
	}

	const upstream = await fetchUpstream(source.url);
	if (!upstream) {
		return new Response("Upstream image unavailable", { status: 502 });
	}

	const ext = EXT_BY_TYPE[upstream.contentType] ?? "jpg";
	await Bun.write(`${cacheBase}.${ext}`, upstream.bytes, { createPath: true });

	return new Response(upstream.bytes, {
		headers: {
			"Content-Type": upstream.contentType,
			"Cache-Control": "public, max-age=86400",
		},
	});
}

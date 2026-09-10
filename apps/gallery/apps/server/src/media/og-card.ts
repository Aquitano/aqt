import { db } from "@aqt-gallery/db";
import { exhibition, placement, room } from "@aqt-gallery/db/schema/exhibition";
import type { Theme } from "@aqt-gallery/db/schema/theme";
import { asc, eq, inArray } from "drizzle-orm";
import sharp, { type OverlayOptions } from "sharp";

import { servePublicImage, serveStoredImage } from "./public-image";
import type { MediaStore } from "./store";

/**
 * Renders the social-share (Open Graph / Twitter) card for a published
 * exhibition: a 1200x630 PNG composed from the entity's theme colour, its
 * cover artwork, and its name / tagline / counts. Composed once with sharp,
 * then cached exactly like the proxied public images beside it. The URL is
 * slug-stable, so the card is served with a modest max-age (not immutable): an
 * edit purges the cache (see delete-files.ts) on delete, unpublish, or cover
 * change, and crawlers/CDNs revalidate within the hour instead of pinning a
 * stale card for a year.
 *
 * Only published entities are served; there is no owner-preview path (a draft
 * has no shareable link yet), so an unpublished, personal or missing entity is
 * a 404 — mirroring the publish gate in public-image's `sourceFor`.
 */

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

/** Bumped when the card layout/encoding changes so stale files are re-derived
 * instead of served (mirrors public-image's CACHE_VERSION). */
const CACHE_VERSION = "v1";

const DEFAULT_BG = "#14110d";

/** The card's cache key for one exhibition, sans extension:
 * `public-image-cache/exhibition-<safeId>-og-<version>`. Shares the
 * proxied-image cache prefix; the `-og-` segment keeps it from ever colliding
 * with a `public-image` variant. The id is sanitised so a crafted id can't
 * escape the cache prefix. Single source of truth for both the serve path and
 * the purge path so they can't drift. */
function cacheBaseFor(id: string, version: string = CACHE_VERSION): string {
	const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	const suffix = version ? `-${version}` : "";
	return `public-image-cache/exhibition-${safeId}-og${suffix}`;
}

/** Every OG-card object that could exist for an exhibition, across cache-scheme
 * versions. Used by the cover-cache purge paths so a card doesn't linger with
 * stale imagery after a delete/unpublish/cover change. */
export function ogCardCacheTargets(id: string): string[] {
	const versions = [CACHE_VERSION];
	return versions.map((v) => `${cacheBaseFor(id, v)}.png`);
}

type EntityCard = {
	id: string;
	name: string;
	tagline: string | null;
	description: string | null;
	theme: Theme | null;
	coverImageUrl: string | null;
	coverArtworkId: string | null;
	kicker: string;
	counts: string;
	firstArtworkId: string | undefined;
};

const KIND_LABEL: Record<string, string> = {
	exhibition: "Exhibition",
	artist_collection: "Artist collection",
	collection: "Collection",
	custom: "Collection",
};

/** Load a published exhibition by slug plus its room/artwork counts, or null
 * when missing, unpublished or personal (there is no owner preview for share
 * cards). */
async function loadExhibition(slug: string): Promise<EntityCard | null> {
	const rows = await db
		.select({
			id: exhibition.id,
			kind: exhibition.kind,
			name: exhibition.name,
			tagline: exhibition.tagline,
			description: exhibition.description,
			theme: exhibition.theme,
			coverImageUrl: exhibition.coverImageUrl,
			coverArtworkId: exhibition.coverArtworkId,
			isPublished: exhibition.isPublished,
		})
		.from(exhibition)
		.where(eq(exhibition.slug, slug))
		.limit(1);
	const e = rows[0];
	if (!e?.isPublished || e.kind === "personal") return null;

	const rooms = await db
		.select({ id: room.id })
		.from(room)
		.where(eq(room.exhibitionId, e.id))
		.orderBy(asc(room.sortOrder));
	const placements =
		rooms.length === 0
			? []
			: await db
					.select({ artworkId: placement.artworkId })
					.from(placement)
					.where(
						inArray(
							placement.roomId,
							rooms.map((r) => r.id),
						),
					)
					.orderBy(asc(placement.position));

	const artworkCount = `${placements.length} ${plural(placements.length, "artwork")}`;
	return {
		id: e.id,
		name: e.name,
		tagline: e.tagline,
		description: e.description,
		theme: e.theme,
		coverImageUrl: e.coverImageUrl,
		coverArtworkId: e.coverArtworkId,
		kicker: e.tagline?.trim() || KIND_LABEL[e.kind] || "Exhibition",
		counts:
			rooms.length > 1
				? `${rooms.length} ${plural(rooms.length, "room")} · ${artworkCount}`
				: artworkCount,
		firstArtworkId: placements[0]?.artworkId,
	};
}

function plural(n: number, word: string): string {
	return n === 1 ? word : `${word}s`;
}

/** Where the card's cover pixels come from, mirroring the display cover
 * resolution in the exhibitions router (chosen member artwork, then a stored
 * remote cover, then the first hung artwork). Returned as a public-image
 * reference so the fetch reuses that module's cache, SSRF guard, and resize
 * cap. */
function coverRef(card: EntityCard): {
	entity: "artwork" | "exhibition";
	id: string;
	variant: "thumb" | "cover";
} | null {
	if (card.coverArtworkId) {
		return { entity: "artwork", id: card.coverArtworkId, variant: "thumb" };
	}
	if (card.coverImageUrl) {
		return { entity: "exhibition", id: card.id, variant: "cover" };
	}
	if (card.firstArtworkId) {
		return { entity: "artwork", id: card.firstArtworkId, variant: "thumb" };
	}
	return null;
}

async function loadCoverBytes(
	store: MediaStore,
	ref: ReturnType<typeof coverRef>,
	checkUpstreamBudget?: () => { ok: boolean; retryAfterMs: number },
): Promise<Buffer | null> {
	if (!ref) return null;
	const res = await servePublicImage({
		store,
		entity: ref.entity,
		id: ref.id,
		variant: ref.variant,
		checkUpstreamBudget,
	});
	if (!res.ok) return null;
	return Buffer.from(await res.arrayBuffer());
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Owner-set theme colours are free-form strings; only pass a validated hex
 * through to sharp's canvas background so an odd value falls back instead of
 * throwing mid-compose. */
function bgColorFor(theme: Theme | null): string {
	const wall = theme?.wallColor;
	return wall && HEX_COLOR.test(wall) ? wall : DEFAULT_BG;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** Greedy word-wrap for the entity name into at most two lines, ellipsising an
 * overflow. Character budgets are tuned to the 64px serif and the card's
 * left-padded text column — good enough for a preview card, not a typesetter. */
function wrapName(name: string): string[] {
	const maxPerLine = 20;
	const maxLines = 2;
	const words = name.trim().split(/\s+/);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (candidate.length <= maxPerLine || !current) {
			current = candidate;
		} else {
			lines.push(current);
			current = word;
			if (lines.length === maxLines - 1) break;
		}
	}
	if (current && lines.length < maxLines) lines.push(current);
	const remainingStart = lines.join(" ").length;
	if (remainingStart < name.trim().length && lines.length > 0) {
		const last = lines[lines.length - 1] ?? "";
		lines[lines.length - 1] = `${last.slice(0, maxPerLine - 1).trimEnd()}…`;
	}
	return lines.length > 0 ? lines : [name.trim()];
}

const KICKER = "#cbb87f";
const NAME_COLOR = "#f4efe3";
const COUNTS_COLOR = "#b7a989";

/** The gradient scrim + text block, as an SVG the caller composites over the
 * cover. Bottom-anchored to echo the lobby's cinematic panels. */
function buildOverlaySvg(kicker: string, nameLines: string[], counts: string) {
	const px = 80;
	const nameLineH = 74;
	const lastNameBaseline = 512;
	const topNameBaseline = lastNameBaseline - (nameLines.length - 1) * nameLineH;
	const kickerBaseline = topNameBaseline - 52;
	const countsBaseline = 578;

	const nameTspans = nameLines
		.map((line, i) => {
			const y = topNameBaseline + i * nameLineH;
			return `<text x="${px}" y="${y}" font-family="Georgia, 'Times New Roman', serif" font-size="64" font-weight="700" fill="${NAME_COLOR}">${escapeXml(line)}</text>`;
		})
		.join("");

	return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.3" stop-color="#0b0a09" stop-opacity="0"/>
      <stop offset="1" stop-color="#0b0a09" stop-opacity="0.94"/>
    </linearGradient>
  </defs>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#scrim)"/>
  <text x="${px}" y="${kickerBaseline}" font-family="Helvetica, Arial, sans-serif" font-size="24" letter-spacing="6" fill="${KICKER}">${escapeXml(kicker.toUpperCase())}</text>
  ${nameTspans}
  <text x="${px}" y="${countsBaseline}" font-family="Helvetica, Arial, sans-serif" font-size="22" letter-spacing="4" fill="${COUNTS_COLOR}">${escapeXml(counts.toUpperCase())}</text>
</svg>`);
}

async function composeCard(
	card: EntityCard,
	coverBytes: Buffer | null,
): Promise<Buffer> {
	const overlay = buildOverlaySvg(
		card.kicker,
		wrapName(card.name),
		card.counts,
	);
	const composites: OverlayOptions[] = [];

	if (coverBytes) {
		try {
			const cover = await sharp(coverBytes)
				.resize(CARD_WIDTH, CARD_HEIGHT, {
					fit: "cover",
					position: "attention",
				})
				.toBuffer();
			composites.push({ input: cover, left: 0, top: 0 });
		} catch {
			// Undecodable cover — fall through to the themed background alone.
		}
	}
	composites.push({ input: overlay, left: 0, top: 0 });

	return sharp({
		create: {
			width: CARD_WIDTH,
			height: CARD_HEIGHT,
			channels: 3,
			background: bgColorFor(card.theme),
		},
	})
		.composite(composites)
		.png()
		.toBuffer();
}

/** The card lives at a slug-stable URL whose contents change on any edit, so it
 * can't be immutable: a modest max-age keeps crawler/CDN traffic cheap while the
 * ETag makes each hourly revalidation a 304. Edits purge the cache, so the
 * next fetch after max-age expiry re-derives a fresh card. */
const OG_CARD_CACHE_CONTROL = "public, max-age=3600";

function serveCachedCard(
	store: MediaStore,
	key: string,
	ifNoneMatch: string | undefined,
): Promise<Response | null> {
	return serveStoredImage({
		store,
		key,
		contentType: "image/png",
		cacheControl: OG_CARD_CACHE_CONTROL,
		ifNoneMatch,
	});
}

export async function serveOgCard(options: {
	store: MediaStore;
	slug: string;
	ifNoneMatch?: string;
	checkUpstreamBudget?: () => { ok: boolean; retryAfterMs: number };
}): Promise<Response> {
	const { store, slug, ifNoneMatch, checkUpstreamBudget } = options;

	const card = await loadExhibition(slug);
	if (!card) {
		return new Response("Not found", { status: 404 });
	}

	const cacheKey = `${cacheBaseFor(card.id)}.png`;
	const cached = await serveCachedCard(store, cacheKey, ifNoneMatch);
	if (cached) return cached;

	const ref = coverRef(card);
	const coverBytes = await loadCoverBytes(store, ref, checkUpstreamBudget);
	const png = await composeCard(card, coverBytes);

	// A cover ref that resolved to no bytes is a transient fetch failure (upstream
	// 5xx/429, or main's short-lived negative cache). Serve this coverless card
	// for the current request but don't persist it — otherwise a brief blip bakes
	// a coverless card into the cache that survives until the next edit. `no-store`
	// keeps crawlers/CDNs from pinning it too, so the cover reappears as soon as
	// upstream recovers. When no cover ref exists at all, the coverless card is
	// correct and caches normally below.
	if (ref && !coverBytes) {
		return new Response(new Uint8Array(png), {
			headers: {
				"Content-Type": "image/png",
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	}

	await store.put(cacheKey, png, "image/png");

	// Serve back through the same cache path so the freshly-written bytes carry
	// the exact validator a later revalidating request would compute. Fall back
	// to the in-memory bytes if the read somehow fails.
	const served = await serveCachedCard(store, cacheKey, ifNoneMatch);
	if (served) return served;
	return new Response(new Uint8Array(png), {
		headers: {
			"Content-Type": "image/png",
			"Cache-Control": OG_CARD_CACHE_CONTROL,
			"X-Content-Type-Options": "nosniff",
		},
	});
}

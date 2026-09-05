import { createHmac, timingSafeEqual } from "node:crypto";
import { rm, unlink } from "node:fs/promises";
import path from "node:path";

import { db } from "@aqt/gallery-db";
import { artist, artwork, tag } from "@aqt/gallery-db/schema/gallery";
import { artGroup } from "@aqt/gallery-db/schema/museum";
import { apiToken } from "@aqt/gallery-db/schema/tokens";
import { eq } from "drizzle-orm";

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
export function verifyClerkWebhook(secret: string, headers: SvixHeaders, body: string): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() - ts * 1000) > SVIX_TOLERANCE_MS) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();

  return signature.split(" ").some((part) => {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) return false;
    let provided: Buffer;
    try {
      provided = Buffer.from(value, "base64");
    } catch {
      return false;
    }
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
}

const PUBLIC_IMAGE_VARIANTS = ["full", "thumb"] as const;
const PUBLIC_IMAGE_EXTS = ["jpg", "png", "webp", "gif"] as const;

async function bestEffortUnlink(filePath: string) {
  await unlink(filePath).catch(() => {
    /* file already gone or unreadable — cleanup is best-effort */
  });
}

export type PurgeResult = {
  artworks: number;
  galleries: number;
  artists: number;
  tags: number;
  tokens: number;
};

/**
 * Remove everything a now-deleted Clerk user owns. Identities live in Clerk,
 * not in this database, so nothing cascades when an account is deleted there —
 * without this, a deleted user's published galleries stay publicly walkable
 * forever. Artworks cascade to their media assets, custom fields, tag links,
 * placements, and gallery memberships; the remaining owned rows are deleted
 * explicitly. On-disk media is cleaned best-effort after the rows are gone.
 */
export async function purgeUserData(userId: string, uploadRoot: string): Promise<PurgeResult> {
  // Capture artwork ids up front — needed to clear the per-artwork public
  // image cache after the rows (and their paths) are gone.
  const ownArtworks = await db
    .select({ id: artwork.id })
    .from(artwork)
    .where(eq(artwork.userId, userId));

  const result = await db.transaction(async (tx) => {
    // Cascades: media_asset, artwork_custom_field, artwork_tag, placement,
    // group_artwork.
    const arts = await tx
      .delete(artwork)
      .where(eq(artwork.userId, userId))
      .returning({ id: artwork.id });
    const groups = await tx
      .delete(artGroup)
      .where(eq(artGroup.createdBy, userId))
      .returning({ id: artGroup.id });
    const artists = await tx
      .delete(artist)
      .where(eq(artist.userId, userId))
      .returning({ id: artist.id });
    const tags = await tx.delete(tag).where(eq(tag.userId, userId)).returning({ id: tag.id });
    const tokens = await tx
      .delete(apiToken)
      .where(eq(apiToken.userId, userId))
      .returning({ id: apiToken.id });
    return {
      artworks: arts.length,
      galleries: groups.length,
      artists: artists.length,
      tags: tags.length,
      tokens: tokens.length,
    };
  });

  // Best-effort disk cleanup — never let a filesystem error fail the webhook
  // (Clerk would retry, but the DB rows are already gone).
  await rm(path.join(uploadRoot, "originals", userId), {
    recursive: true,
    force: true,
  }).catch(() => {});
  await rm(path.join(uploadRoot, "thumbs", userId), {
    recursive: true,
    force: true,
  }).catch(() => {});

  const cacheDir = path.join(uploadRoot, "public-image-cache");
  for (const { id } of ownArtworks) {
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    for (const variant of PUBLIC_IMAGE_VARIANTS) {
      for (const ext of PUBLIC_IMAGE_EXTS) {
        await bestEffortUnlink(path.join(cacheDir, `artwork-${safeId}-${variant}.${ext}`));
      }
    }
  }

  return result;
}

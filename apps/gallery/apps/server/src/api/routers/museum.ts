import path from "node:path";

import { db } from "@aqt/gallery-db";
import { artist, artwork, mediaAsset } from "@aqt/gallery-db/schema/gallery";
import { artGroup, groupArtwork, museum, placement, room } from "@aqt/gallery-db/schema/museum";
import { themeSchema } from "@aqt/gallery-db/schema/theme";
import { env } from "@aqt/gallery-env/server";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, ne, or } from "drizzle-orm";
import { z } from "zod";

import { deleteEntityCacheFiles } from "../../media/delete-files";
import { protectedProcedure, publicProcedure, router } from "../index";

/** All imagery is served by this API (downloaded + cached server-side);
 * the browser never fetches the stored source URLs directly. */
function publicImageUrl(
  entity: "artwork" | "museum" | "group",
  id: string,
  variant: "full" | "thumb" | "cover",
) {
  return `${env.SERVER_URL}/public-image/${entity}/${id}/${variant}`;
}

/** Resolve a group's display cover. An explicitly chosen member artwork
 * wins; then a stored remote cover (seeded content); then the first hung
 * artwork; otherwise nothing. */
function groupCoverUrl(
  g: {
    id: string;
    coverArtworkId: string | null;
    coverImageUrl: string | null;
  },
  firstArtworkId: string | undefined,
) {
  if (g.coverArtworkId) {
    return publicImageUrl("artwork", g.coverArtworkId, "thumb");
  }
  if (g.coverImageUrl) {
    return publicImageUrl("group", g.id, "cover");
  }
  if (firstArtworkId) {
    return publicImageUrl("artwork", firstArtworkId, "thumb");
  }
  return null;
}

/** Resolve a museum's display cover, mirroring {@link groupCoverUrl}: an
 * explicitly chosen member artwork wins; then a stored remote cover (seeded
 * content); then the first hung artwork; otherwise nothing. */
function museumCoverUrl(
  m: {
    id: string;
    coverArtworkId: string | null;
    coverImageUrl: string | null;
  },
  firstArtworkId: string | undefined,
) {
  if (m.coverArtworkId) {
    return publicImageUrl("artwork", m.coverArtworkId, "thumb");
  }
  if (m.coverImageUrl) {
    return publicImageUrl("museum", m.id, "cover");
  }
  if (firstArtworkId) {
    return publicImageUrl("artwork", firstArtworkId, "thumb");
  }
  return null;
}

/** Public artwork payload for the 3D museum. Only published artworks
 * are ever returned; personal-archive fields (rating, review…) stay private.
 * Uploaded artworks (no external imageUrl) fall back to their primary
 * media asset for image presence and pixel dimensions. */
function toPublicArtwork(
  a: typeof artwork.$inferSelect,
  artistRow: typeof artist.$inferSelect | null,
  asset: { width: number | null; height: number | null } | null,
) {
  const hasImage = Boolean(a.imageUrl || asset);
  return {
    id: a.id,
    title: a.title,
    artistName: artistRow?.name ?? a.artist,
    artist: artistRow
      ? {
          id: artistRow.id,
          slug: artistRow.slug,
          name: artistRow.name,
          bio: artistRow.bio,
          birthYear: artistRow.birthYear,
          deathYear: artistRow.deathYear,
          nationality: artistRow.nationality,
        }
      : null,
    year: a.year,
    medium: a.medium,
    dimensions: a.dimensions,
    description: a.description,
    story: a.story,
    funFacts: a.funFacts ?? [],
    imageUrl: hasImage ? publicImageUrl("artwork", a.id, "full") : null,
    thumbnailUrl: hasImage ? publicImageUrl("artwork", a.id, "thumb") : null,
    imageWidth: a.imageWidth ?? asset?.width ?? null,
    imageHeight: a.imageHeight ?? asset?.height ?? null,
  };
}

export type PublicArtwork = ReturnType<typeof toPublicArtwork>;

async function loadArtworksWithArtists(artworkIds: string[]) {
  if (artworkIds.length === 0) {
    return new Map<string, PublicArtwork>();
  }
  const rows = await db
    .select()
    .from(artwork)
    .leftJoin(artist, eq(artist.id, artwork.artistId))
    .leftJoin(mediaAsset, eq(mediaAsset.id, artwork.primaryAssetId))
    .where(and(inArray(artwork.id, artworkIds), eq(artwork.isPublished, true)));
  return new Map(
    rows.map((row) => [
      row.artwork.id,
      toPublicArtwork(
        row.artwork,
        row.artist,
        row.media_asset ? { width: row.media_asset.width, height: row.media_asset.height } : null,
      ),
    ]),
  );
}

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "gallery"
  );
}

/** Slugs are globally unique across groups; suffix on collision. */
async function uniqueGroupSlug(name: string) {
  const base = slugify(name);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await db
      .select({ id: artGroup.id })
      .from(artGroup)
      .where(eq(artGroup.slug, candidate))
      .limit(1);
    if (!existing[0]) {
      return candidate;
    }
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

async function requireOwnGroup(groupId: string, userId: string) {
  const rows = await db
    .select()
    .from(artGroup)
    .where(and(eq(artGroup.id, groupId), eq(artGroup.createdBy, userId)))
    .limit(1);
  const g = rows[0];
  if (!g) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Gallery not found" });
  }
  return g;
}

/** Museum slugs are globally unique across museums; suffix on collision. */
async function uniqueMuseumSlug(name: string) {
  const base = slugify(name);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await db
      .select({ id: museum.id })
      .from(museum)
      .where(eq(museum.slug, candidate))
      .limit(1);
    if (!existing[0]) {
      return candidate;
    }
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Room slugs only need to be unique within their museum. */
async function uniqueRoomSlug(museumId: string, name: string) {
  const base = slugify(name);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await db
      .select({ id: room.id })
      .from(room)
      .where(and(eq(room.museumId, museumId), eq(room.slug, candidate)))
      .limit(1);
    if (!existing[0]) {
      return candidate;
    }
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

async function requireOwnMuseum(museumId: string, userId: string) {
  const rows = await db
    .select()
    .from(museum)
    .where(and(eq(museum.id, museumId), eq(museum.createdBy, userId)))
    .limit(1);
  const m = rows[0];
  if (!m) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Museum not found" });
  }
  return m;
}

/** Resolve a room and assert the caller owns its museum, returning both rows. */
async function requireOwnRoom(roomId: string, userId: string) {
  const rows = await db
    .select()
    .from(room)
    .innerJoin(museum, eq(museum.id, room.museumId))
    .where(and(eq(room.id, roomId), eq(museum.createdBy, userId)))
    .limit(1);
  const found = rows[0];
  if (!found) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Room not found" });
  }
  return found;
}

/** Bump a museum's update time so any room-level edit resurfaces it to the
 * top of the studio list (which sorts by updatedAt). Room rows have their own
 * timestamp, so changing them never touches the parent on its own. */
function touchMuseum(museumId: string) {
  return db.update(museum).set({ updatedAt: new Date() }).where(eq(museum.id, museumId));
}

export const museumRouter = router({
  /** Everything the lobby needs: published museums (with room counts)
   * and published groups (exhibitions, artist collections). */
  lobby: publicProcedure.query(async () => {
    const [museums, rooms, groups, groupCounts] = await Promise.all([
      db.select().from(museum).where(eq(museum.isPublished, true)).orderBy(asc(museum.sortOrder)),
      db
        .select({
          id: room.id,
          museumId: room.museumId,
          name: room.name,
        })
        .from(room)
        .orderBy(asc(room.sortOrder)),
      db
        .select()
        .from(artGroup)
        .where(eq(artGroup.isPublished, true))
        .orderBy(asc(artGroup.sortOrder)),
      db
        .select({
          groupId: groupArtwork.groupId,
          artworkId: groupArtwork.artworkId,
          position: groupArtwork.position,
        })
        .from(groupArtwork)
        .orderBy(asc(groupArtwork.position)),
    ]);

    const roomCountByMuseum = new Map<string, { count: number; names: string[] }>();
    for (const r of rooms) {
      const entry = roomCountByMuseum.get(r.museumId) ?? {
        count: 0,
        names: [],
      };
      entry.count += 1;
      entry.names.push(r.name);
      roomCountByMuseum.set(r.museumId, entry);
    }
    const placementRows = await db
      .select({
        roomId: placement.roomId,
        artworkId: placement.artworkId,
      })
      .from(placement)
      .orderBy(asc(placement.position));
    const roomIdToMuseum = new Map(rooms.map((r) => [r.id, r.museumId]));
    const artworkCountByMuseum = new Map<string, number>();
    const firstArtworkByRoom = new Map<string, string>();
    for (const p of placementRows) {
      const mId = roomIdToMuseum.get(p.roomId);
      if (mId) {
        artworkCountByMuseum.set(mId, (artworkCountByMuseum.get(mId) ?? 0) + 1);
      }
      if (!firstArtworkByRoom.has(p.roomId)) {
        firstArtworkByRoom.set(p.roomId, p.artworkId);
      }
    }
    // First artwork of a museum = first room (by sortOrder) that has any,
    // then that room's first placement. `rooms` is already sorted.
    const firstArtworkByMuseum = new Map<string, string>();
    for (const r of rooms) {
      if (firstArtworkByMuseum.has(r.museumId)) continue;
      const first = firstArtworkByRoom.get(r.id);
      if (first) {
        firstArtworkByMuseum.set(r.museumId, first);
      }
    }
    const artworkCountByGroup = new Map<string, number>();
    const firstArtworkByGroup = new Map<string, string>();
    for (const g of groupCounts) {
      artworkCountByGroup.set(g.groupId, (artworkCountByGroup.get(g.groupId) ?? 0) + 1);
      if (!firstArtworkByGroup.has(g.groupId)) {
        firstArtworkByGroup.set(g.groupId, g.artworkId);
      }
    }

    return {
      museums: museums.map((m) => ({
        id: m.id,
        slug: m.slug,
        name: m.name,
        tagline: m.tagline,
        description: m.description,
        coverImageUrl: museumCoverUrl(m, firstArtworkByMuseum.get(m.id)),
        theme: m.theme,
        roomCount: roomCountByMuseum.get(m.id)?.count ?? 0,
        roomNames: roomCountByMuseum.get(m.id)?.names ?? [],
        artworkCount: artworkCountByMuseum.get(m.id) ?? 0,
      })),
      groups: groups.map((g) => ({
        id: g.id,
        slug: g.slug,
        kind: g.kind,
        name: g.name,
        tagline: g.tagline,
        description: g.description,
        coverImageUrl: groupCoverUrl(g, firstArtworkByGroup.get(g.id)),
        theme: g.theme,
        artworkCount: artworkCountByGroup.get(g.id) ?? 0,
      })),
    };
  }),

  /** Full payload to render a museum in 3D: rooms in order, each with
   * ordered placements joined to published artworks + artists. */
  museum: publicProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const viewerId = ctx.session?.user.id;
      const museumRows = await db
        .select()
        .from(museum)
        .where(
          and(
            eq(museum.slug, input.slug),
            viewerId
              ? or(eq(museum.isPublished, true), eq(museum.createdBy, viewerId))
              : eq(museum.isPublished, true),
          ),
        )
        .limit(1);
      const m = museumRows[0];
      if (!m) {
        return null;
      }

      const rooms = await db
        .select()
        .from(room)
        .where(eq(room.museumId, m.id))
        .orderBy(asc(room.sortOrder));

      const placements =
        rooms.length === 0
          ? []
          : await db
              .select()
              .from(placement)
              .where(
                inArray(
                  placement.roomId,
                  rooms.map((r) => r.id),
                ),
              )
              .orderBy(asc(placement.position));

      const artworkMap = await loadArtworksWithArtists(placements.map((p) => p.artworkId));

      return {
        id: m.id,
        slug: m.slug,
        name: m.name,
        tagline: m.tagline,
        description: m.description,
        theme: m.theme,
        isPublished: m.isPublished,
        isOwner: Boolean(viewerId && m.createdBy === viewerId),
        rooms: rooms.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          description: r.description,
          layout: r.layout,
          artworks: placements
            .filter((p) => p.roomId === r.id)
            .flatMap((p) => {
              const art = artworkMap.get(p.artworkId);
              if (!art) return [];
              return [
                {
                  ...art,
                  placement: {
                    position: p.position,
                    wall: p.wall,
                    wallOffset: p.wallOffset,
                    scale: p.scale,
                  },
                },
              ];
            }),
        })),
      };
    }),

  /** Full payload to render a group (exhibition / artist collection /
   * custom collection) as a single auto-generated 3D gallery.
   * Owners can also preview their own not-yet-published galleries. */
  group: publicProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const viewerId = ctx.session?.user.id;
      const groupRows = await db
        .select()
        .from(artGroup)
        .leftJoin(artist, eq(artist.id, artGroup.artistId))
        .where(
          and(
            eq(artGroup.slug, input.slug),
            viewerId
              ? or(eq(artGroup.isPublished, true), eq(artGroup.createdBy, viewerId))
              : eq(artGroup.isPublished, true),
          ),
        )
        .limit(1);
      const g = groupRows[0];
      if (!g) {
        return null;
      }

      const memberships = await db
        .select()
        .from(groupArtwork)
        .where(eq(groupArtwork.groupId, g.art_group.id))
        .orderBy(asc(groupArtwork.position));

      const artworkMap = await loadArtworksWithArtists(memberships.map((mw) => mw.artworkId));

      return {
        id: g.art_group.id,
        slug: g.art_group.slug,
        kind: g.art_group.kind,
        name: g.art_group.name,
        tagline: g.art_group.tagline,
        description: g.art_group.description,
        theme: g.art_group.theme,
        isPublished: g.art_group.isPublished,
        isOwner: Boolean(viewerId && g.art_group.createdBy === viewerId),
        artist: g.artist
          ? {
              id: g.artist.id,
              slug: g.artist.slug,
              name: g.artist.name,
              bio: g.artist.bio,
              birthYear: g.artist.birthYear,
              deathYear: g.artist.deathYear,
              nationality: g.artist.nationality,
            }
          : null,
        rooms: [
          {
            id: g.art_group.id,
            slug: g.art_group.slug,
            name: g.art_group.name,
            description: g.art_group.description,
            layout: null,
            artworks: memberships.flatMap((mw) => {
              const art = artworkMap.get(mw.artworkId);
              if (!art) return [];
              return [
                {
                  ...art,
                  placement: {
                    position: mw.position,
                    wall: null,
                    wallOffset: null,
                    scale: null,
                  },
                },
              ];
            }),
          },
        ],
      };
    }),

  /** The signed-in user's own curated 3D galleries (including drafts),
   * with ordered membership so the studio can edit without extra round
   * trips. */
  myGroups: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const groups = await db
      .select()
      .from(artGroup)
      .where(eq(artGroup.createdBy, userId))
      .orderBy(desc(artGroup.updatedAt));
    const memberships =
      groups.length === 0
        ? []
        : await db
            .select({
              groupId: groupArtwork.groupId,
              artworkId: groupArtwork.artworkId,
            })
            .from(groupArtwork)
            .where(
              inArray(
                groupArtwork.groupId,
                groups.map((g) => g.id),
              ),
            )
            .orderBy(asc(groupArtwork.position));

    const artworkIdsByGroup = new Map<string, string[]>();
    for (const m of memberships) {
      const list = artworkIdsByGroup.get(m.groupId) ?? [];
      list.push(m.artworkId);
      artworkIdsByGroup.set(m.groupId, list);
    }

    return groups.map((g) => {
      const artworkIds = artworkIdsByGroup.get(g.id) ?? [];
      return {
        id: g.id,
        slug: g.slug,
        kind: g.kind,
        name: g.name,
        tagline: g.tagline,
        description: g.description,
        theme: g.theme,
        isPublished: g.isPublished,
        coverArtworkId: g.coverArtworkId,
        coverImageUrl: groupCoverUrl(g, artworkIds[0]),
        artworkIds,
        updatedAt: g.updatedAt,
      };
    });
  }),

  /** Create a new (unpublished) curated gallery owned by the caller. */
  createGroup: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(120),
        tagline: z.string().max(200).nullable().optional(),
        description: z.string().max(2000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const slug = await uniqueGroupSlug(input.name);
      const rows = await db
        .insert(artGroup)
        .values({
          id: crypto.randomUUID(),
          slug,
          kind: "custom",
          name: input.name,
          tagline: input.tagline ?? null,
          description: input.description ?? null,
          createdBy: ctx.session.user.id,
          isPublished: false,
        })
        .returning();
      return rows[0];
    }),

  updateGroup: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1).max(120).optional(),
        tagline: z.string().max(200).nullable().optional(),
        description: z.string().max(2000).nullable().optional(),
        theme: themeSchema.nullable().optional(),
        coverArtworkId: z.string().min(1).nullable().optional(),
        isPublished: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwnGroup(input.id, ctx.session.user.id);
      // A chosen cover must be a member of this gallery.
      if (input.coverArtworkId) {
        const member = await db
          .select({ artworkId: groupArtwork.artworkId })
          .from(groupArtwork)
          .where(
            and(
              eq(groupArtwork.groupId, input.id),
              eq(groupArtwork.artworkId, input.coverArtworkId),
            ),
          )
          .limit(1);
        if (!member[0]) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cover artwork must be in this gallery",
          });
        }
      }
      const rows = await db
        .update(artGroup)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.tagline !== undefined ? { tagline: input.tagline } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.theme !== undefined ? { theme: input.theme } : {}),
          ...(input.coverArtworkId !== undefined ? { coverArtworkId: input.coverArtworkId } : {}),
          ...(input.isPublished !== undefined ? { isPublished: input.isPublished } : {}),
        })
        .where(eq(artGroup.id, input.id))
        .returning();
      return rows[0];
    }),

  deleteGroup: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnGroup(input.id, ctx.session.user.id);
      await db.delete(artGroup).where(eq(artGroup.id, input.id));
      await deleteEntityCacheFiles({
        uploadRoot: path.resolve(env.UPLOAD_DIR),
        entity: "group",
        id: input.id,
      });
      return { ok: true };
    }),

  /** Replace a gallery's artworks with the given ordered list — the
   * single sync point the studio calls after any add/remove/reorder.
   * Callers may hang their own artworks (auto-published so the public
   * image route can serve them) or any already-published artwork. */
  setGroupArtworks: protectedProcedure
    .input(
      z.object({
        groupId: z.string().min(1),
        artworkIds: z.array(z.string().min(1)).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const group = await requireOwnGroup(input.groupId, userId);

      const unique = [...new Set(input.artworkIds)];
      const allowed =
        unique.length === 0
          ? []
          : await db
              .select({ id: artwork.id, userId: artwork.userId })
              .from(artwork)
              .where(
                and(
                  inArray(artwork.id, unique),
                  or(eq(artwork.userId, userId), eq(artwork.isPublished, true)),
                ),
              );
      const allowedIds = new Set(allowed.map((a) => a.id));
      const ordered = unique.filter((id) => allowedIds.has(id));

      const ownArtworkIds = allowed.filter((a) => a.userId === userId).map((a) => a.id);
      if (ownArtworkIds.length > 0) {
        await db
          .update(artwork)
          .set({ isPublished: true })
          .where(and(inArray(artwork.id, ownArtworkIds), eq(artwork.userId, userId)));
      }

      await db.delete(groupArtwork).where(eq(groupArtwork.groupId, input.groupId));
      if (ordered.length > 0) {
        await db.insert(groupArtwork).values(
          ordered.map((artworkId, position) => ({
            groupId: input.groupId,
            artworkId,
            position,
          })),
        );
      }
      // Drop a chosen cover that's no longer hung in this gallery.
      const coverRemoved = group.coverArtworkId !== null && !ordered.includes(group.coverArtworkId);
      await db
        .update(artGroup)
        .set({
          updatedAt: new Date(),
          ...(coverRemoved ? { coverArtworkId: null } : {}),
        })
        .where(eq(artGroup.id, input.groupId));

      return { ok: true, artworkIds: ordered };
    }),

  /** The signed-in user's own multi-room museums (including drafts), each
   * with its ordered rooms and each room's ordered artworkIds — everything
   * the studio needs to edit without extra round trips. */
  myMuseums: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const museums = await db
      .select()
      .from(museum)
      .where(eq(museum.createdBy, userId))
      .orderBy(desc(museum.updatedAt));
    if (museums.length === 0) {
      return [];
    }

    const rooms = await db
      .select()
      .from(room)
      .where(
        inArray(
          room.museumId,
          museums.map((m) => m.id),
        ),
      )
      .orderBy(asc(room.sortOrder));
    const placements =
      rooms.length === 0
        ? []
        : await db
            .select({
              roomId: placement.roomId,
              artworkId: placement.artworkId,
            })
            .from(placement)
            .where(
              inArray(
                placement.roomId,
                rooms.map((r) => r.id),
              ),
            )
            .orderBy(asc(placement.position));

    const artworkIdsByRoom = new Map<string, string[]>();
    for (const p of placements) {
      const list = artworkIdsByRoom.get(p.roomId) ?? [];
      list.push(p.artworkId);
      artworkIdsByRoom.set(p.roomId, list);
    }
    const roomsByMuseum = new Map<string, typeof rooms>();
    for (const r of rooms) {
      const list = roomsByMuseum.get(r.museumId) ?? [];
      list.push(r);
      roomsByMuseum.set(r.museumId, list);
    }

    return museums.map((m) => {
      const mRooms = roomsByMuseum.get(m.id) ?? [];
      const firstRoomWithArt = mRooms.find((r) => (artworkIdsByRoom.get(r.id) ?? []).length > 0);
      const firstArtworkId = firstRoomWithArt
        ? artworkIdsByRoom.get(firstRoomWithArt.id)?.[0]
        : undefined;
      return {
        id: m.id,
        slug: m.slug,
        name: m.name,
        tagline: m.tagline,
        description: m.description,
        theme: m.theme,
        isPublished: m.isPublished,
        coverArtworkId: m.coverArtworkId,
        coverImageUrl: museumCoverUrl(m, firstArtworkId),
        updatedAt: m.updatedAt,
        rooms: mRooms.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          description: r.description,
          layout: r.layout,
          sortOrder: r.sortOrder,
          artworkIds: artworkIdsByRoom.get(r.id) ?? [],
        })),
      };
    });
  }),

  /** Create a new (unpublished) multi-room museum owned by the caller. */
  createMuseum: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(120),
        tagline: z.string().max(200).nullable().optional(),
        description: z.string().max(2000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const slug = await uniqueMuseumSlug(input.name);
      const rows = await db
        .insert(museum)
        .values({
          id: crypto.randomUUID(),
          slug,
          name: input.name,
          tagline: input.tagline ?? null,
          description: input.description ?? null,
          createdBy: ctx.session.user.id,
          isPublished: false,
        })
        .returning();
      return rows[0];
    }),

  updateMuseum: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1).max(120).optional(),
        tagline: z.string().max(200).nullable().optional(),
        description: z.string().max(2000).nullable().optional(),
        theme: themeSchema.nullable().optional(),
        coverArtworkId: z.string().min(1).nullable().optional(),
        isPublished: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await requireOwnMuseum(input.id, ctx.session.user.id);
      // A chosen cover must be hung somewhere in this museum.
      if (input.coverArtworkId) {
        const member = await db
          .select({ artworkId: placement.artworkId })
          .from(placement)
          .innerJoin(room, eq(room.id, placement.roomId))
          .where(and(eq(room.museumId, input.id), eq(placement.artworkId, input.coverArtworkId)))
          .limit(1);
        if (!member[0]) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cover artwork must be in this museum",
          });
        }
      }
      const set: Partial<typeof museum.$inferInsert> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.tagline !== undefined) set.tagline = input.tagline;
      if (input.description !== undefined) set.description = input.description;
      if (input.theme !== undefined) set.theme = input.theme;
      if (input.coverArtworkId !== undefined) {
        set.coverArtworkId = input.coverArtworkId;
      }
      if (input.isPublished !== undefined) set.isPublished = input.isPublished;
      if (Object.keys(set).length === 0) {
        return existing;
      }
      const rows = await db.update(museum).set(set).where(eq(museum.id, input.id)).returning();
      return rows[0];
    }),

  deleteMuseum: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnMuseum(input.id, ctx.session.user.id);
      // Rooms + placements cascade; member artworks themselves are kept.
      await db.delete(museum).where(eq(museum.id, input.id));
      await deleteEntityCacheFiles({
        uploadRoot: path.resolve(env.UPLOAD_DIR),
        entity: "museum",
        id: input.id,
      });
      return { ok: true };
    }),

  /** Add a room to a museum, appended after the existing rooms. */
  createRoom: protectedProcedure
    .input(
      z.object({
        museumId: z.string().min(1),
        name: z.string().min(1).max(120),
        description: z.string().max(2000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwnMuseum(input.museumId, ctx.session.user.id);
      const slug = await uniqueRoomSlug(input.museumId, input.name);
      const existing = await db
        .select({ sortOrder: room.sortOrder })
        .from(room)
        .where(eq(room.museumId, input.museumId));
      const nextSort = existing.reduce((max, r) => Math.max(max, r.sortOrder), -1) + 1;
      const rows = await db
        .insert(room)
        .values({
          id: crypto.randomUUID(),
          museumId: input.museumId,
          slug,
          name: input.name,
          description: input.description ?? null,
          sortOrder: nextSort,
        })
        .returning();
      await touchMuseum(input.museumId);
      return rows[0];
    }),

  updateRoom: protectedProcedure
    .input(
      z.object({
        roomId: z.string().min(1),
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(2000).nullable().optional(),
        layout: z
          .object({
            width: z.number().positive().max(200).optional(),
            depth: z.number().positive().max(200).optional(),
            height: z.number().positive().max(50).optional(),
          })
          .nullable()
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { room: existing, museum: ownerMuseum } = await requireOwnRoom(
        input.roomId,
        ctx.session.user.id,
      );
      const set: Partial<typeof room.$inferInsert> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.description !== undefined) set.description = input.description;
      if (input.layout !== undefined) set.layout = input.layout;
      if (Object.keys(set).length === 0) {
        return existing;
      }
      const rows = await db.update(room).set(set).where(eq(room.id, input.roomId)).returning();
      await touchMuseum(ownerMuseum.id);
      return rows[0];
    }),

  deleteRoom: protectedProcedure
    .input(z.object({ roomId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { museum: ownerMuseum } = await requireOwnRoom(input.roomId, ctx.session.user.id);
      // Placements in the room cascade; the artworks themselves are kept.
      await db.delete(room).where(eq(room.id, input.roomId));
      await touchMuseum(ownerMuseum.id);
      return { ok: true };
    }),

  /** Reorder a museum's rooms to match the given id order. Ids not belonging
   * to the museum are ignored; any owned room the caller omits keeps its
   * relative order *after* the listed ones, so sortOrder always stays a
   * contiguous 0..n-1 (a partial list can never leave two rooms colliding). */
  reorderRooms: protectedProcedure
    .input(
      z.object({
        museumId: z.string().min(1),
        roomIds: z.array(z.string().min(1)).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwnMuseum(input.museumId, ctx.session.user.id);
      const owned = await db
        .select({ id: room.id })
        .from(room)
        .where(eq(room.museumId, input.museumId))
        .orderBy(asc(room.sortOrder));
      const ownedIds = owned.map((r) => r.id);
      const requested = input.roomIds.filter((id) => ownedIds.includes(id));
      const requestedSet = new Set(requested);
      const ordered = [...requested, ...ownedIds.filter((id) => !requestedSet.has(id))];
      await db.transaction(async (tx) => {
        for (const [index, id] of ordered.entries()) {
          await tx
            .update(room)
            .set({ sortOrder: index })
            .where(and(eq(room.id, id), eq(room.museumId, input.museumId)));
        }
      });
      await touchMuseum(input.museumId);
      return { ok: true, roomIds: ordered };
    }),

  /** Replace a room's artworks with the given ordered list — the single sync
   * point the studio calls after any add/remove/reorder within a room.
   * Mirrors {@link setGroupArtworks}: callers may hang their own artworks
   * (auto-published so the public image route can serve them) or any
   * already-published artwork. */
  setRoomArtworks: protectedProcedure
    .input(
      z.object({
        roomId: z.string().min(1),
        artworkIds: z.array(z.string().min(1)).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const { museum: ownerMuseum } = await requireOwnRoom(input.roomId, userId);

      const unique = [...new Set(input.artworkIds)];
      const allowed =
        unique.length === 0
          ? []
          : await db
              .select({ id: artwork.id, userId: artwork.userId })
              .from(artwork)
              .where(
                and(
                  inArray(artwork.id, unique),
                  or(eq(artwork.userId, userId), eq(artwork.isPublished, true)),
                ),
              );
      const allowedIds = new Set(allowed.map((a) => a.id));
      const ordered = unique.filter((id) => allowedIds.has(id));

      const ownArtworkIds = allowed.filter((a) => a.userId === userId).map((a) => a.id);
      if (ownArtworkIds.length > 0) {
        await db
          .update(artwork)
          .set({ isPublished: true })
          .where(and(inArray(artwork.id, ownArtworkIds), eq(artwork.userId, userId)));
      }

      await db.delete(placement).where(eq(placement.roomId, input.roomId));
      if (ordered.length > 0) {
        // An artwork hangs in at most one room of a museum — pull anything
        // being hung here out of the museum's other rooms first, so the
        // invariant the studio enforces in the UI also holds for the MCP /
        // API path (and the lobby's per-placement count stays honest).
        const siblingRooms = await db
          .select({ id: room.id })
          .from(room)
          .where(and(eq(room.museumId, ownerMuseum.id), ne(room.id, input.roomId)));
        const siblingRoomIds = siblingRooms.map((r) => r.id);
        if (siblingRoomIds.length > 0) {
          await db
            .delete(placement)
            .where(
              and(inArray(placement.roomId, siblingRoomIds), inArray(placement.artworkId, ordered)),
            );
        }
        await db.insert(placement).values(
          ordered.map((artworkId, position) => ({
            roomId: input.roomId,
            artworkId,
            position,
          })),
        );
      }

      // Drop the museum cover only if the artwork is no longer hung in any
      // of its rooms (it may still hang in a different room than this one).
      let clearCover = false;
      if (ownerMuseum.coverArtworkId && !ordered.includes(ownerMuseum.coverArtworkId)) {
        const stillHung = await db
          .select({ artworkId: placement.artworkId })
          .from(placement)
          .innerJoin(room, eq(room.id, placement.roomId))
          .where(
            and(
              eq(room.museumId, ownerMuseum.id),
              eq(placement.artworkId, ownerMuseum.coverArtworkId),
            ),
          )
          .limit(1);
        clearCover = !stillHung[0];
      }
      await db
        .update(museum)
        .set({
          updatedAt: new Date(),
          ...(clearCover ? { coverArtworkId: null } : {}),
        })
        .where(eq(museum.id, ownerMuseum.id));

      return { ok: true, artworkIds: ordered };
    }),
});

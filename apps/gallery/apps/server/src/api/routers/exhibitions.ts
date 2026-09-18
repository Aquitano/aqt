import { db } from "@aqt/gallery-db";
import { museumStat } from "@aqt/gallery-db/schema/analytics";
import {
  type ExhibitionKind,
  exhibition,
  exhibitionKinds,
  placement,
  room,
} from "@aqt/gallery-db/schema/exhibition";
import { artist, artwork, mediaAsset } from "@aqt/gallery-db/schema/gallery";
import { themeSchema } from "@aqt/gallery-db/schema/theme";
import { env } from "@aqt/gallery-env/server";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { deleteEntityCacheFiles, deleteOgCardFiles } from "../../media/delete-files";
import { mediaStore } from "../../media/store";
import { protectedProcedure, publicProcedure, router } from "../index";
import { visibleToUser } from "./gallery-helpers";
import { type LintArtwork, runLint } from "./lint";

/** All imagery is served by this API (downloaded + cached server-side);
 * the browser never fetches the stored source URLs directly. */
function publicImageUrl(
  entity: "artwork" | "exhibition",
  id: string,
  variant: "full" | "mid" | "thumb" | "cover",
) {
  return `${env.SERVER_URL}/public-image/${entity}/${id}/${variant}`;
}

/** Resolve an exhibition's display cover. An explicitly chosen member artwork
 * wins; then a stored remote cover (seeded content); then the first hung
 * artwork; otherwise nothing. */
function coverUrl(
  e: {
    id: string;
    coverArtworkId: string | null;
    coverImageUrl: string | null;
  },
  firstArtworkId: string | undefined,
) {
  if (e.coverArtworkId) {
    return publicImageUrl("artwork", e.coverArtworkId, "thumb");
  }
  if (e.coverImageUrl) {
    return publicImageUrl("exhibition", e.id, "cover");
  }
  if (firstArtworkId) {
    return publicImageUrl("artwork", firstArtworkId, "thumb");
  }
  return null;
}

/** The artwork columns the public payload is built from; the exhibition query
 * selects only these so the prose and private-note columns never leave the
 * database for a whole-exhibition load. The heavy prose (description, story,
 * fun facts, artist bio) is lazy-fetched per artwork via `artworkDetail`, so
 * the payload stays small no matter how many works hang. */
const publicArtworkColumns = {
  id: artwork.id,
  title: artwork.title,
  artist: artwork.artist,
  year: artwork.year,
  medium: artwork.medium,
  dimensions: artwork.dimensions,
  imageUrl: artwork.imageUrl,
  imageWidth: artwork.imageWidth,
  imageHeight: artwork.imageHeight,
};
type PublicArtworkRow = {
  [K in keyof typeof publicArtworkColumns]: (typeof artwork.$inferSelect)[K];
};

const publicArtistColumns = {
  id: artist.id,
  slug: artist.slug,
  name: artist.name,
  birthYear: artist.birthYear,
  deathYear: artist.deathYear,
  nationality: artist.nationality,
};
type PublicArtistRow = {
  [K in keyof typeof publicArtistColumns]: (typeof artist.$inferSelect)[K];
};

/** Public artwork payload for the 3D renderer. Personal-archive fields
 * (rating, review…) stay private. Uploaded artworks (no external imageUrl)
 * fall back to their primary media asset for image presence and pixel
 * dimensions. */
function toPublicArtwork(
  a: PublicArtworkRow,
  artistRow: PublicArtistRow | null,
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
          birthYear: artistRow.birthYear,
          deathYear: artistRow.deathYear,
          nationality: artistRow.nationality,
        }
      : null,
    year: a.year,
    medium: a.medium,
    dimensions: a.dimensions,
    imageUrl: hasImage ? publicImageUrl("artwork", a.id, "full") : null,
    midUrl: hasImage ? publicImageUrl("artwork", a.id, "mid") : null,
    thumbnailUrl: hasImage ? publicImageUrl("artwork", a.id, "thumb") : null,
    imageWidth: a.imageWidth ?? asset?.width ?? null,
    imageHeight: a.imageHeight ?? asset?.height ?? null,
  };
}

export type PublicArtwork = ReturnType<typeof toPublicArtwork>;

/** Load the renderable artworks among `artworkIds`. A personal collection is
 * viewed by its owner only, so it may also hang the owner's unpublished works
 * (`ownerId`); everything else renders published, live works only. */
async function loadArtworksWithArtists(artworkIds: string[], ownerId?: string) {
  if (artworkIds.length === 0) {
    return new Map<string, PublicArtwork>();
  }
  const visible = ownerId
    ? or(eq(artwork.isPublished, true), eq(artwork.userId, ownerId))
    : eq(artwork.isPublished, true);
  const rows = await db
    .select({
      artwork: publicArtworkColumns,
      artist: publicArtistColumns,
      asset: { width: mediaAsset.width, height: mediaAsset.height },
    })
    .from(artwork)
    .leftJoin(artist, eq(artist.id, artwork.artistId))
    .leftJoin(mediaAsset, eq(mediaAsset.id, artwork.primaryAssetId))
    .where(and(inArray(artwork.id, artworkIds), visible, isNull(artwork.deletedAt)));
  return new Map(
    rows.map((row) => [row.artwork.id, toPublicArtwork(row.artwork, row.artist, row.asset)]),
  );
}

/** Load the linter's view of a set of hung artworks by id. Unlike
 * {@link loadArtworksWithArtists} this does NOT filter by published/deleted —
 * the linter needs to report a hung work that is deleted or unpublished, since
 * the renderer would silently drop it. Only lint-relevant, non-private columns
 * are selected. */
async function loadLintArtworks(artworkIds: string[]): Promise<Map<string, LintArtwork>> {
  if (artworkIds.length === 0) {
    return new Map<string, LintArtwork>();
  }
  const rows = await db
    .select({
      id: artwork.id,
      title: artwork.title,
      dimensions: artwork.dimensions,
      story: artwork.story,
      artistId: artwork.artistId,
      artistFree: artwork.artist,
      imageUrl: artwork.imageUrl,
      imageWidth: artwork.imageWidth,
      imageHeight: artwork.imageHeight,
      isPublished: artwork.isPublished,
      deletedAt: artwork.deletedAt,
      assetId: mediaAsset.id,
      assetWidth: mediaAsset.width,
      assetHeight: mediaAsset.height,
    })
    .from(artwork)
    .leftJoin(mediaAsset, eq(mediaAsset.id, artwork.primaryAssetId))
    .where(inArray(artwork.id, artworkIds));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        title: r.title,
        dimensions: r.dimensions,
        story: r.story,
        artistId: r.artistId,
        artistName: r.artistFree,
        hasImage: Boolean(r.imageUrl || r.assetId),
        imageWidth: r.imageWidth ?? r.assetWidth,
        imageHeight: r.imageHeight ?? r.assetHeight,
        isPublished: r.isPublished,
        isDeleted: r.deletedAt != null,
      } satisfies LintArtwork,
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
      .slice(0, 64) || "exhibition"
  );
}

/** Exhibition slugs are globally unique; suffix on collision. */
export async function uniqueExhibitionSlug(name: string) {
  const base = slugify(name);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await db
      .select({ id: exhibition.id })
      .from(exhibition)
      .where(eq(exhibition.slug, candidate))
      .limit(1);
    if (!existing[0]) {
      return candidate;
    }
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Room slugs only need to be unique within their exhibition. */
async function uniqueRoomSlug(exhibitionId: string, name: string) {
  const base = slugify(name);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await db
      .select({ id: room.id })
      .from(room)
      .where(and(eq(room.exhibitionId, exhibitionId), eq(room.slug, candidate)))
      .limit(1);
    if (!existing[0]) {
      return candidate;
    }
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

async function requireOwnExhibition(exhibitionId: string, userId: string) {
  const rows = await db
    .select()
    .from(exhibition)
    .where(and(eq(exhibition.id, exhibitionId), eq(exhibition.createdBy, userId)))
    .limit(1);
  const e = rows[0];
  if (!e) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Exhibition not found",
    });
  }
  return e;
}

/** Resolve a room and assert the caller owns its exhibition, returning both
 * rows. */
async function requireOwnRoom(roomId: string, userId: string) {
  const rows = await db
    .select()
    .from(room)
    .innerJoin(exhibition, eq(exhibition.id, room.exhibitionId))
    .where(and(eq(room.id, roomId), eq(exhibition.createdBy, userId)))
    .limit(1);
  const found = rows[0];
  if (!found) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Room not found" });
  }
  return found;
}

/** Aggregate anonymous visit counters for one published exhibition into a
 * compact owner-facing summary: per-metric totals plus the three most-inspected
 * works. `sum(...)::int` so Postgres returns JS numbers rather than bigint
 * strings. */
async function loadVisitStats(exhibitionId: string) {
  const totalCount = sql<number>`coalesce(sum(${museumStat.count}), 0)::int`;
  const [totals, topArtworks] = await Promise.all([
    db
      .select({ metric: museumStat.metric, total: totalCount })
      .from(museumStat)
      .where(and(eq(museumStat.entityKind, "exhibition"), eq(museumStat.entityId, exhibitionId)))
      .groupBy(museumStat.metric),
    db
      .select({
        artworkId: museumStat.artworkId,
        title: artwork.title,
        artistName: artwork.artist,
        count: totalCount,
      })
      .from(museumStat)
      .innerJoin(artwork, eq(artwork.id, museumStat.artworkId))
      .where(
        and(
          eq(museumStat.entityKind, "exhibition"),
          eq(museumStat.entityId, exhibitionId),
          eq(museumStat.metric, "inspect_open"),
        ),
      )
      .groupBy(museumStat.artworkId, artwork.title, artwork.artist)
      .orderBy(desc(totalCount))
      .limit(3),
  ]);

  const byMetric = new Map(totals.map((row) => [row.metric, row.total]));
  return {
    pageViews: byMetric.get("page_view") ?? 0,
    sessionsEntered: byMetric.get("session_entered") ?? 0,
    toursCompleted: byMetric.get("tour_completed") ?? 0,
    topArtworks: topArtworks.map((a) => ({
      id: a.artworkId,
      title: a.title,
      artistName: a.artistName,
      count: a.count,
    })),
  };
}

/** Bump an exhibition's update time so any room-level edit resurfaces it to
 * the top of the studio list (which sorts by updatedAt). Room rows have their
 * own timestamp, so changing them never touches the parent on its own. */
function touchExhibition(exhibitionId: string) {
  return db
    .update(exhibition)
    .set({ updatedAt: new Date() })
    .where(eq(exhibition.id, exhibitionId));
}

function purgeOgCard(exhibitionId: string) {
  return deleteOgCardFiles({
    store: mediaStore,
    entity: "exhibition",
    id: exhibitionId,
  });
}

/** Bucket already-sorted rows by a key in one pass, preserving order within
 * each bucket. Avoids O(rooms * placements) re-filtering when regrouping
 * placements per room. */
function bucketBy<T, K>(rows: readonly T[], keyOf: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

/** Publication is coupled to being hung: an own artwork is auto-published when
 * hung in a public exhibition and must stop being published once it hangs in
 * none — otherwise its image stays anonymously fetchable forever through the
 * public-image route. Given candidate own-artwork ids (e.g. ones just removed
 * from a room), unpublish those no longer placed in any non-personal
 * exhibition. Only the caller's own rows are touched, so an artwork another
 * user still hangs (because it was public) keeps serving for them. */
async function unpublishOrphanedArtworks(userId: string, candidateIds: string[]) {
  const unique = [...new Set(candidateIds)];
  if (unique.length === 0) return;
  // One statement so the "still hung?" read and the unpublish are atomic. A
  // separate SELECT-then-UPDATE races a concurrent hang: the work picks up a
  // new placement between the two and is wrongly unpublished, 404ing its image.
  // The correlated NOT EXISTS is re-evaluated against a row's committed state
  // when a concurrent hang touches it, so a just-hung work stays published.
  await db
    .update(artwork)
    .set({ isPublished: false })
    .where(
      and(
        inArray(artwork.id, unique),
        eq(artwork.userId, userId),
        sql`not exists (
					select 1 from ${placement}
					inner join ${room} on ${room.id} = ${placement.roomId}
					inner join ${exhibition} on ${exhibition.id} = ${room.exhibitionId}
					where ${placement.artworkId} = ${artwork.id}
					and ${exhibition.kind} <> 'personal'
				)`,
      ),
    );
}

/** One artwork's curated 3D placement on a wall, plus the owner's note. Each
 * field is an optional partial patch: absent leaves it untouched, an explicit
 * null clears it back to the procedural auto-layout. */
const placementDetailSchema = z.object({
  artworkId: z.string().min(1),
  wall: z.enum(["north", "south", "east", "west"]).nullable().optional(),
  wallOffset: z.number().min(0).max(1).nullable().optional(),
  scale: z.number().min(0.1).max(5).nullable().optional(),
  note: z
    .string()
    .max(1_000)
    .nullable()
    .optional()
    .describe("A private curator note on this hang; never shown to visitors."),
});

type PlacementDetailInput = z.infer<typeof placementDetailSchema>;

/** Explicit room dimensions (meters). Used as-is by the 3D layout engine in
 * place of its procedural sizing. Shared by createRoom and updateRoom. */
const roomLayoutSchema = z.object({
  width: z.number().positive().max(200).optional(),
  depth: z.number().positive().max(200).optional(),
  height: z.number().positive().max(50).optional(),
});

/** The Drizzle `set` for a placement patch — only the keys the caller sent. */
function placementSetValues(detail: PlacementDetailInput) {
  const set: {
    wall?: PlacementDetailInput["wall"];
    wallOffset?: number | null;
    scale?: number | null;
    note?: string | null;
  } = {};
  if (detail.wall !== undefined) set.wall = detail.wall;
  if (detail.wallOffset !== undefined) set.wallOffset = detail.wallOffset;
  if (detail.scale !== undefined) set.scale = detail.scale;
  if (detail.note !== undefined) set.note = detail.note;
  return set;
}

/** The kinds a curator picks from. `personal` is the journal's private
 * collection and is created there, never through this router. */
const curatedKindSchema = z.enum(
  exhibitionKinds.filter(
    (kind): kind is Exclude<ExhibitionKind, "personal"> => kind !== "personal",
  ),
);

/** A cover / first-artwork id is only usable publicly if that artwork is
 * itself published and not soft-deleted — otherwise the public-image route
 * 404s and the lobby shows a broken image. Resolve the valid set once and
 * gate both cover and first-artwork fallback selection on it. */
async function resolveValidCoverIds(
  placementRows: readonly { artworkId: string }[],
  exhibitions: readonly { coverArtworkId: string | null }[],
): Promise<Set<string>> {
  const coverCandidateIds = [
    ...placementRows.map((p) => p.artworkId),
    ...exhibitions.flatMap((e) => (e.coverArtworkId ? [e.coverArtworkId] : [])),
  ];
  const validCoverIds = new Set<string>();
  if (coverCandidateIds.length > 0) {
    const validRows = await db
      .select({ id: artwork.id })
      .from(artwork)
      .where(
        and(
          inArray(artwork.id, [...new Set(coverCandidateIds)]),
          eq(artwork.isPublished, true),
          isNull(artwork.deletedAt),
        ),
      );
    for (const row of validRows) validCoverIds.add(row.id);
  }
  return validCoverIds;
}

/** Per-exhibition artwork counts and the fallback first-artwork used as a
 * cover when none is chosen: the first room (by sortOrder) that hangs any valid
 * artwork, then that room's first valid placement. `rooms` must already be
 * sorted. */
function computeArtworkStats(
  rooms: readonly { id: string; exhibitionId: string }[],
  placementRows: readonly { roomId: string; artworkId: string }[],
  validCoverIds: ReadonlySet<string>,
) {
  const roomIdToExhibition = new Map(rooms.map((r) => [r.id, r.exhibitionId]));
  const countByExhibition = new Map<string, number>();
  const firstArtworkByRoom = new Map<string, string>();
  for (const p of placementRows) {
    const exhibitionId = roomIdToExhibition.get(p.roomId);
    if (exhibitionId) {
      countByExhibition.set(exhibitionId, (countByExhibition.get(exhibitionId) ?? 0) + 1);
    }
    if (validCoverIds.has(p.artworkId) && !firstArtworkByRoom.has(p.roomId)) {
      firstArtworkByRoom.set(p.roomId, p.artworkId);
    }
  }
  const firstByExhibition = new Map<string, string>();
  for (const r of rooms) {
    if (firstByExhibition.has(r.exhibitionId)) continue;
    const first = firstArtworkByRoom.get(r.id);
    if (first) {
      firstByExhibition.set(r.exhibitionId, first);
    }
  }
  return { countByExhibition, firstByExhibition };
}

/** Resolve which requested artworks the caller may hang: their own works (any
 * state) plus anyone's already-published works, deduped and kept in request
 * order. Returns that ordered candidate list and the set of the caller's own
 * ids among them — the caller auto-publishes those it actually hangs so the
 * public-image route can serve them. */
async function resolveHangableArtworks(userId: string, artworkIds: string[]) {
  const unique = [...new Set(artworkIds)];
  const allowed =
    unique.length === 0
      ? []
      : await db
          .select({ id: artwork.id, userId: artwork.userId })
          .from(artwork)
          .where(and(inArray(artwork.id, unique), visibleToUser(userId)));
  const allowedIds = new Set(allowed.map((a) => a.id));
  const orderedIds = unique.filter((id) => allowedIds.has(id));
  const ownIds = new Set(allowed.filter((a) => a.userId === userId).map((a) => a.id));
  return { orderedIds, ownIds };
}

/** Auto-publish the caller's own works when they are hung somewhere public.
 * A personal collection is viewed by its owner only, so hanging there must not
 * expose the work through the public-image route. */
function publishesHungArtworks(kind: ExhibitionKind) {
  return kind !== "personal";
}

async function loadRoomsWithPlacements(exhibitionIds: string[]) {
  if (exhibitionIds.length === 0) {
    return { rooms: [], placements: [] };
  }
  const rooms = await db
    .select()
    .from(room)
    .where(inArray(room.exhibitionId, exhibitionIds))
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
  return { rooms, placements };
}

/** The renderer payload for one exhibition: rooms in order, each with ordered
 * placements joined to renderable artworks + artists. Shared by `bySlug` and
 * the journal's private exhibit view. */
export async function loadExhibitionRender(
  e: typeof exhibition.$inferSelect,
  artistRow: typeof artist.$inferSelect | null,
  viewerId: string | undefined,
) {
  const isOwner = Boolean(viewerId && e.createdBy === viewerId);
  const { rooms, placements } = await loadRoomsWithPlacements([e.id]);
  const artworkMap = await loadArtworksWithArtists(
    placements.map((p) => p.artworkId),
    e.kind === "personal" && isOwner ? viewerId : undefined,
  );
  const placementsByRoom = bucketBy(placements, (p) => p.roomId);

  return {
    id: e.id,
    slug: e.slug,
    kind: e.kind,
    name: e.name,
    tagline: e.tagline,
    description: e.description,
    theme: e.theme,
    isPublished: e.isPublished,
    isOwner,
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
    rooms: rooms.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      layout: r.layout,
      artworks: (placementsByRoom.get(r.id) ?? []).flatMap((p) => {
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
              // A hang note is the owner's; visitors never see it.
              note: isOwner ? p.note : null,
            },
          },
        ];
      }),
    })),
  };
}

const exhibitionUpdateSchema = z.object({
  exhibitionId: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  tagline: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  theme: themeSchema.nullable().optional(),
  coverArtworkId: z.string().min(1).nullable().optional(),
  isPublished: z.boolean().optional(),
  kind: curatedKindSchema.optional(),
});

/** Patch an exhibition's editable columns. Shared by the `update` and
 * `publish` mutations so both go through the same ownership, cover-membership
 * and personal-collection guards. */
async function updateExhibition(userId: string, input: z.infer<typeof exhibitionUpdateSchema>) {
  const existing = await requireOwnExhibition(input.exhibitionId, userId);
  // A chosen cover must be hung somewhere in this exhibition.
  if (input.coverArtworkId) {
    const member = await db
      .select({ artworkId: placement.artworkId })
      .from(placement)
      .innerJoin(room, eq(room.id, placement.roomId))
      .where(
        and(
          eq(room.exhibitionId, input.exhibitionId),
          eq(placement.artworkId, input.coverArtworkId),
        ),
      )
      .limit(1);
    if (!member[0]) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cover artwork must be hung in this exhibition",
      });
    }
  }
  // A personal collection may hang the owner's unpublished works, so it
  // can never go public as-is; change its kind first.
  if (input.isPublished && (input.kind ?? existing.kind) === "personal") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A personal collection cannot be published",
    });
  }
  const set: Partial<typeof exhibition.$inferInsert> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.tagline !== undefined) set.tagline = input.tagline;
  if (input.description !== undefined) set.description = input.description;
  if (input.theme !== undefined) set.theme = input.theme;
  if (input.coverArtworkId !== undefined) {
    set.coverArtworkId = input.coverArtworkId;
  }
  if (input.isPublished !== undefined) set.isPublished = input.isPublished;
  if (input.kind !== undefined) set.kind = input.kind;
  if (Object.keys(set).length === 0) {
    return existing;
  }
  const rows = await db
    .update(exhibition)
    .set(set)
    .where(eq(exhibition.id, input.exhibitionId))
    .returning();
  // The share card bakes in name/tagline/theme/cover/publish state, so
  // any edit here invalidates it — re-derive on next share.
  await purgeOgCard(input.exhibitionId);
  return rows[0];
}

export const exhibitionsRouter = router({
  /** Everything the lobby needs: published exhibitions with room counts,
   * names and a resolved cover. Personal collections never appear. */
  lobby: publicProcedure.query(async () => {
    const exhibitions = await db
      .select()
      .from(exhibition)
      .where(and(eq(exhibition.isPublished, true), ne(exhibition.kind, "personal")))
      .orderBy(asc(exhibition.sortOrder));
    const { rooms, placements } = await loadRoomsWithPlacements(exhibitions.map((e) => e.id));

    const roomsByExhibition = bucketBy(rooms, (r) => r.exhibitionId);
    const validCoverIds = await resolveValidCoverIds(placements, exhibitions);
    const { countByExhibition, firstByExhibition } = computeArtworkStats(
      rooms,
      placements,
      validCoverIds,
    );

    return {
      exhibitions: exhibitions.map((e) => {
        const eRooms = roomsByExhibition.get(e.id) ?? [];
        return {
          id: e.id,
          slug: e.slug,
          kind: e.kind,
          name: e.name,
          tagline: e.tagline,
          description: e.description,
          coverImageUrl: coverUrl(
            {
              ...e,
              coverArtworkId:
                e.coverArtworkId && validCoverIds.has(e.coverArtworkId) ? e.coverArtworkId : null,
            },
            firstByExhibition.get(e.id),
          ),
          theme: e.theme,
          roomCount: eRooms.length,
          roomNames: eRooms.map((r) => r.name),
          artworkCount: countByExhibition.get(e.id) ?? 0,
        };
      }),
    };
  }),

  /** Full payload to render an exhibition in 3D. Owners can also preview
   * their own drafts; a personal collection resolves for its owner only. */
  bySlug: publicProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const viewerId = ctx.session?.user.id;
      const rows = await db
        .select()
        .from(exhibition)
        .leftJoin(artist, eq(artist.id, exhibition.artistId))
        .where(
          and(
            eq(exhibition.slug, input.slug),
            viewerId
              ? or(
                  and(eq(exhibition.isPublished, true), ne(exhibition.kind, "personal")),
                  eq(exhibition.createdBy, viewerId),
                )
              : and(eq(exhibition.isPublished, true), ne(exhibition.kind, "personal")),
          ),
        )
        .limit(1);
      const found = rows[0];
      if (!found) {
        return null;
      }
      return loadExhibitionRender(found.exhibition, found.artist, viewerId);
    }),

  /** Minimal published-entity fields for server-rendered social/meta tags on
   * the public walk routes. Deliberately published-only (no owner preview)
   * and on its own query key so it never seeds — or is seeded by — the heavy
   * render payload the page draws from. */
  shareMeta: publicProcedure
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ input }) => {
      const rows = await db
        .select({
          id: exhibition.id,
          name: exhibition.name,
          tagline: exhibition.tagline,
          description: exhibition.description,
        })
        .from(exhibition)
        .where(
          and(
            eq(exhibition.slug, input.slug),
            eq(exhibition.isPublished, true),
            ne(exhibition.kind, "personal"),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    }),

  /** The prose for one inspected artwork, kept out of the whole-exhibition
   * payload (see {@link toPublicArtwork}) and fetched only when a visitor
   * opens the inspect panel. Published-only, matching what the renderer
   * ever hangs, so no private draft text leaks through this public route. */
  artworkDetail: publicProcedure
    .input(z.object({ artworkId: z.string().min(1) }))
    .query(async ({ input }) => {
      const rows = await db
        .select({
          id: artwork.id,
          description: artwork.description,
          story: artwork.story,
          funFacts: artwork.funFacts,
          artistBio: artist.bio,
        })
        .from(artwork)
        .leftJoin(artist, eq(artist.id, artwork.artistId))
        .where(
          and(
            eq(artwork.id, input.artworkId),
            eq(artwork.isPublished, true),
            isNull(artwork.deletedAt),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) {
        return null;
      }
      return {
        id: row.id,
        description: row.description,
        story: row.story,
        funFacts: row.funFacts ?? [],
        artistBio: row.artistBio,
      };
    }),

  /** The signed-in user's own exhibitions (including drafts and personal
   * collections), each with its ordered rooms and every room's ordered
   * placements — everything the studio needs to edit without extra round
   * trips. Most recently edited first. */
  mine: protectedProcedure
    .meta({
      mcp: {
        name: "list_exhibitions",
        title: "List exhibitions",
        description:
          "List the user's exhibitions (including drafts), each with its ordered rooms and every room's ordered placements (artworkId, wall, wallOffset, scale, note) and publish state. Entries of kind \"personal\" are the user's private journal collections.",
        readOnly: true,
      },
    })
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;
      const exhibitions = await db
        .select()
        .from(exhibition)
        .where(eq(exhibition.createdBy, userId))
        .orderBy(desc(exhibition.updatedAt));
      const { rooms, placements } = await loadRoomsWithPlacements(exhibitions.map((e) => e.id));
      const placementsByRoom = bucketBy(placements, (p) => p.roomId);
      const roomsByExhibition = bucketBy(rooms, (r) => r.exhibitionId);

      return exhibitions.map((e) => {
        const eRooms = roomsByExhibition.get(e.id) ?? [];
        const firstArtworkId = eRooms
          .map((r) => placementsByRoom.get(r.id)?.[0]?.artworkId)
          .find((id) => id !== undefined);
        return {
          id: e.id,
          slug: e.slug,
          kind: e.kind,
          name: e.name,
          tagline: e.tagline,
          description: e.description,
          theme: e.theme,
          isPublished: e.isPublished,
          coverArtworkId: e.coverArtworkId,
          coverImageUrl: coverUrl(e, firstArtworkId),
          artistId: e.artistId,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          rooms: eRooms.map((r) => ({
            id: r.id,
            slug: r.slug,
            name: r.name,
            description: r.description,
            layout: r.layout,
            sortOrder: r.sortOrder,
            placements: (placementsByRoom.get(r.id) ?? []).map((p) => ({
              artworkId: p.artworkId,
              position: p.position,
              wall: p.wall,
              wallOffset: p.wallOffset,
              scale: p.scale,
              note: p.note,
            })),
          })),
        };
      });
    }),

  /** Anonymous visit stats for an exhibition the caller owns. */
  stats: protectedProcedure
    .input(z.object({ exhibitionId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await requireOwnExhibition(input.exhibitionId, ctx.session.user.id);
      return loadVisitStats(input.exhibitionId);
    }),

  /** Create a new (unpublished) exhibition owned by the caller, with one room
   * named after it so a single-room gallery needs no further setup. */
  create: protectedProcedure
    .meta({
      mcp: {
        name: "create_exhibition",
        title: "Create exhibition",
        description:
          "Create a new (unpublished) exhibition owned by the user, with one default room named after it. Returns { id, slug, roomId } — hang artworks into roomId with add_artworks_to_room; add_room only when you want more rooms. kind is the lobby label (default custom).",
      },
    })
    .input(
      z.object({
        name: z.string().min(1).max(120),
        tagline: z.string().max(200).nullable().optional(),
        description: z.string().max(2000).nullable().optional(),
        kind: curatedKindSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const slug = await uniqueExhibitionSlug(input.name);
      const id = crypto.randomUUID();
      const roomId = crypto.randomUUID();
      await db.transaction(async (tx) => {
        await tx.insert(exhibition).values({
          id,
          slug,
          kind: input.kind ?? "custom",
          name: input.name,
          tagline: input.tagline ?? null,
          description: input.description ?? null,
          createdBy: ctx.session.user.id,
          isPublished: false,
        });
        await tx.insert(room).values({
          id: roomId,
          exhibitionId: id,
          slug: "main",
          name: input.name,
          sortOrder: 0,
        });
      });
      return { id, slug, roomId };
    }),

  update: protectedProcedure
    .meta({
      mcp: {
        name: "update_exhibition",
        title: "Update exhibition",
        description:
          "Update an exhibition's name, tagline, description, kind (lobby label), 3D theme, and/or cover artwork. The cover must already be hung in one of its rooms. See gallery://guide for theme fields.",
        idempotent: true,
      },
    })
    .input(exhibitionUpdateSchema)
    .mutation(({ ctx, input }) => updateExhibition(ctx.session.user.id, input)),

  publish: protectedProcedure
    .meta({
      mcp: {
        name: "publish_exhibition",
        title: "Publish / unpublish exhibition",
        description:
          "Set whether an exhibition is publicly visible in the 3D lobby. Publish only when the user is happy with it.",
        idempotent: true,
      },
    })
    .input(z.object({ exhibitionId: z.string().min(1), publish: z.boolean() }))
    .mutation(({ ctx, input }) =>
      updateExhibition(ctx.session.user.id, {
        exhibitionId: input.exhibitionId,
        isPublished: input.publish,
      }),
    ),

  delete: protectedProcedure
    .meta({
      mcp: {
        name: "delete_exhibition",
        title: "Delete exhibition",
        description:
          "Permanently delete an exhibition and all its rooms. The member artworks themselves are kept in the archive.",
        destructive: true,
        idempotent: true,
      },
    })
    .input(z.object({ exhibitionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnExhibition(input.exhibitionId, ctx.session.user.id);
      // Rooms + placements cascade; member artworks themselves are kept.
      const { placements } = await loadRoomsWithPlacements([input.exhibitionId]);
      await db.delete(exhibition).where(eq(exhibition.id, input.exhibitionId));
      await deleteEntityCacheFiles({
        store: mediaStore,
        entity: "exhibition",
        id: input.exhibitionId,
      });
      // Placements cascade-deleted with the rooms may now hang nowhere.
      await unpublishOrphanedArtworks(
        ctx.session.user.id,
        placements.map((p) => p.artworkId),
      );
      return { ok: true };
    }),

  /** Add a room to an exhibition, appended after the existing rooms. */
  createRoom: protectedProcedure
    .meta({
      mcp: {
        name: "add_room",
        title: "Add room to exhibition",
        description:
          "Add a room to an exhibition, appended after the existing rooms (create_exhibition already made the first one). Returns the new room, including its id — use that id to hang artworks with add_artworks_to_room / set_room_artworks. Optionally pass layout (width/depth/height in meters) to size the hall explicitly; omit it to let the layout engine size the room from its artworks (sensible ranges: width ~13-24, depth ~12-30, height ~5-8).",
      },
    })
    .input(
      z.object({
        exhibitionId: z.string().min(1),
        name: z.string().min(1).max(120),
        description: z.string().max(2000).nullable().optional(),
        layout: roomLayoutSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwnExhibition(input.exhibitionId, ctx.session.user.id);
      const slug = await uniqueRoomSlug(input.exhibitionId, input.name);
      // Lock the exhibition row for the read-then-insert so two concurrent
      // createRoom calls can't both read the same max(sortOrder) and insert
      // rooms that collide on sortOrder (there's no unique constraint on it).
      const rows = await db.transaction(async (tx) => {
        await tx
          .select({ id: exhibition.id })
          .from(exhibition)
          .where(eq(exhibition.id, input.exhibitionId))
          .for("update");
        const existing = await tx
          .select({ sortOrder: room.sortOrder })
          .from(room)
          .where(eq(room.exhibitionId, input.exhibitionId));
        const nextSort = existing.reduce((max, r) => Math.max(max, r.sortOrder), -1) + 1;
        return tx
          .insert(room)
          .values({
            id: crypto.randomUUID(),
            exhibitionId: input.exhibitionId,
            slug,
            name: input.name,
            description: input.description ?? null,
            layout: input.layout ?? null,
            sortOrder: nextSort,
          })
          .returning();
      });
      await touchExhibition(input.exhibitionId);
      // A new room bumps the room count baked into the share card.
      await purgeOgCard(input.exhibitionId);
      return rows[0];
    }),

  updateRoom: protectedProcedure
    .meta({
      mcp: {
        name: "update_room",
        title: "Update room",
        description:
          "Update a room's name, description, and/or layout. Pass layout (width/depth/height in meters) to size the hall explicitly, or layout: null to revert to procedural sizing.",
        idempotent: true,
      },
    })
    .input(
      z.object({
        roomId: z.string().min(1),
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(2000).nullable().optional(),
        layout: roomLayoutSchema.nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { room: existing, exhibition: owner } = await requireOwnRoom(
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
      await touchExhibition(owner.id);
      return rows[0];
    }),

  deleteRoom: protectedProcedure
    .meta({
      mcp: {
        name: "delete_room",
        title: "Delete room",
        description:
          "Delete a room from its exhibition. The artworks hung in it are kept in the archive.",
        destructive: true,
        idempotent: true,
      },
    })
    .input(z.object({ roomId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { exhibition: owner } = await requireOwnRoom(input.roomId, ctx.session.user.id);
      // Placements in the room cascade; the artworks themselves are kept.
      const roomPlacements = await db
        .select({ artworkId: placement.artworkId })
        .from(placement)
        .where(eq(placement.roomId, input.roomId));
      await db.delete(room).where(eq(room.id, input.roomId));
      await touchExhibition(owner.id);
      // Room and placement counts and the cover fallback all shifted — drop
      // the stale card.
      await purgeOgCard(owner.id);
      // Placements cascade-deleted with the room may now hang nowhere.
      await unpublishOrphanedArtworks(
        ctx.session.user.id,
        roomPlacements.map((p) => p.artworkId),
      );
      return { ok: true };
    }),

  /** Reorder an exhibition's rooms to match the given id order. Ids not
   * belonging to it are ignored; any owned room the caller omits keeps its
   * relative order *after* the listed ones, so sortOrder always stays a
   * contiguous 0..n-1 (a partial list can never leave two rooms colliding). */
  reorderRooms: protectedProcedure
    .meta({
      mcp: {
        name: "reorder_rooms",
        title: "Reorder exhibition rooms",
        description:
          "Reorder an exhibition's rooms to match this list. Rooms you omit keep their relative order after the listed ones; ids not belonging to the exhibition are ignored.",
        idempotent: true,
      },
    })
    .input(
      z.object({
        exhibitionId: z.string().min(1),
        roomIds: z.array(z.string().min(1)).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwnExhibition(input.exhibitionId, ctx.session.user.id);
      const owned = await db
        .select({ id: room.id })
        .from(room)
        .where(eq(room.exhibitionId, input.exhibitionId))
        .orderBy(asc(room.sortOrder));
      const ownedIds = owned.map((r) => r.id);
      const requested = input.roomIds.filter((id) => ownedIds.includes(id));
      const requestedSet = new Set(requested);
      const ordered = [...requested, ...ownedIds.filter((id) => !requestedSet.has(id))];
      if (ordered.length > 0) {
        // Single CASE update over all owned rooms instead of one round trip
        // per room. `ordered` covers every owned room, so the else branch is
        // never reached.
        const cases = sql.join(
          ordered.map((id, index) => sql`when ${room.id} = ${id} then ${index}`),
          sql` `,
        );
        await db
          .update(room)
          .set({ sortOrder: sql`case ${cases} else ${room.sortOrder} end` })
          .where(and(eq(room.exhibitionId, input.exhibitionId), inArray(room.id, ordered)));
      }
      await touchExhibition(input.exhibitionId);
      return { ok: true, roomIds: ordered };
    }),

  /** Replace a room's artworks with the given ordered list — the single sync
   * point the studio calls after any add/remove/reorder within a room.
   * Callers may hang their own artworks (auto-published so the public image
   * route can serve them) or any already-published artwork. */
  setRoomArtworks: protectedProcedure
    .meta({
      mcp: {
        name: "set_room_artworks",
        title: "Set / reorder room artworks",
        description:
          "Replace a room's full set of artworks with this exact ordered list (use to reorder or remove). Own artworks are auto-published.",
        idempotent: true,
      },
    })
    .input(
      z.object({
        roomId: z.string().min(1),
        artworkIds: z.array(z.string().min(1)).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const { exhibition: owner } = await requireOwnRoom(input.roomId, userId);

      const priorMembers = await db
        .select({ artworkId: placement.artworkId })
        .from(placement)
        .where(eq(placement.roomId, input.roomId));

      const { orderedIds: ordered, ownIds } = await resolveHangableArtworks(
        userId,
        input.artworkIds,
      );
      if (ownIds.size > 0 && publishesHungArtworks(owner.kind)) {
        await db
          .update(artwork)
          .set({ isPublished: true })
          .where(and(inArray(artwork.id, [...ownIds]), eq(artwork.userId, userId)));
      }

      await db.delete(placement).where(eq(placement.roomId, input.roomId));
      if (ordered.length > 0) {
        // An artwork hangs in at most one room of an exhibition — pull
        // anything being hung here out of the other rooms first, so the
        // invariant the studio enforces in the UI also holds for the MCP /
        // API path (and the lobby's per-placement count stays honest).
        const siblingRooms = await db
          .select({ id: room.id })
          .from(room)
          .where(and(eq(room.exhibitionId, owner.id), ne(room.id, input.roomId)));
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

      // Drop the cover only if the artwork is no longer hung in any room
      // (it may still hang in a different room than this one).
      let clearCover = false;
      if (owner.coverArtworkId && !ordered.includes(owner.coverArtworkId)) {
        const stillHung = await db
          .select({ artworkId: placement.artworkId })
          .from(placement)
          .innerJoin(room, eq(room.id, placement.roomId))
          .where(
            and(eq(room.exhibitionId, owner.id), eq(placement.artworkId, owner.coverArtworkId)),
          )
          .limit(1);
        clearCover = !stillHung[0];
      }
      await db
        .update(exhibition)
        .set({
          updatedAt: new Date(),
          ...(clearCover ? { coverArtworkId: null } : {}),
        })
        .where(eq(exhibition.id, owner.id));

      // Unpublish any own artwork removed from this room that now hangs
      // nowhere public (it may still hang in another room/exhibition, in
      // which case the reconciliation leaves it published).
      const orderedSet = new Set(ordered);
      await unpublishOrphanedArtworks(
        userId,
        priorMembers.map((m) => m.artworkId).filter((id) => !orderedSet.has(id)),
      );

      // Placement count and the cover fallback both changed — drop the stale card.
      await purgeOgCard(owner.id);

      return { ok: true, artworkIds: ordered };
    }),

  /** Append artworks to a room without disturbing the existing order, in one
   * transaction (concurrent appends can't clobber each other). Preserves the
   * one-room-per-exhibition invariant by pulling each added work out of the
   * other rooms first, and reports the cap clearly instead of failing an
   * inner Zod max. */
  appendRoomArtworks: protectedProcedure
    .meta({
      mcp: {
        name: "add_artworks_to_room",
        title: "Add artworks to a room",
        description:
          "Append artworks (by id) to a room, keeping the existing order and skipping duplicates. This auto-publishes the added artworks so they can appear in the 3D walk. The exhibition's own draft/published state is independent — use publish_exhibition to make it public.",
      },
    })
    .input(
      z.object({
        roomId: z.string().min(1),
        artworkIds: z.array(z.string().min(1)).min(1).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const { exhibition: owner } = await requireOwnRoom(input.roomId, userId);

      const { orderedIds: candidate, ownIds } = await resolveHangableArtworks(
        userId,
        input.artworkIds,
      );

      const artworkIds = await db.transaction(async (tx) => {
        // Lock the room so concurrent appends serialize on distinct trailing
        // positions.
        await tx.select({ id: room.id }).from(room).where(eq(room.id, input.roomId)).for("update");
        const existing = await tx
          .select({
            artworkId: placement.artworkId,
            position: placement.position,
          })
          .from(placement)
          .where(eq(placement.roomId, input.roomId))
          .orderBy(asc(placement.position));
        const existingIds = new Set(existing.map((e) => e.artworkId));
        const toAdd = candidate.filter((id) => !existingIds.has(id));
        if (existing.length + toAdd.length > 200) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Room is full (max 200 artworks); remove some first.",
          });
        }
        if (toAdd.length > 0) {
          // One room per exhibition: detach the added works from any sibling.
          const siblingRooms = await tx
            .select({ id: room.id })
            .from(room)
            .where(and(eq(room.exhibitionId, owner.id), ne(room.id, input.roomId)));
          const siblingRoomIds = siblingRooms.map((r) => r.id);
          if (siblingRoomIds.length > 0) {
            await tx
              .delete(placement)
              .where(
                and(inArray(placement.roomId, siblingRoomIds), inArray(placement.artworkId, toAdd)),
              );
          }
          let nextPos = existing.reduce((max, e) => Math.max(max, e.position), -1) + 1;
          await tx.insert(placement).values(
            toAdd.map((artworkId) => ({
              roomId: input.roomId,
              artworkId,
              position: nextPos++,
            })),
          );
          const ownToPublish = publishesHungArtworks(owner.kind)
            ? toAdd.filter((id) => ownIds.has(id))
            : [];
          if (ownToPublish.length > 0) {
            await tx
              .update(artwork)
              .set({ isPublished: true })
              .where(and(inArray(artwork.id, ownToPublish), eq(artwork.userId, userId)));
          }
        }
        await tx
          .update(exhibition)
          .set({ updatedAt: new Date() })
          .where(eq(exhibition.id, owner.id));
        return [...existing.map((e) => e.artworkId), ...toAdd];
      });

      // Placement count and the cover fallback both changed — drop the stale card.
      await purgeOgCard(owner.id);

      return { ok: true, artworkIds };
    }),

  /** Curate the 3D hang of a room's artworks: set each one's wall,
   * normalized along-wall offset, display scale and note. Only artworks
   * already hung in the room are touched; unknown ids are ignored. Each field
   * is a partial patch (absent leaves, null clears to auto-layout). */
  setRoomPlacements: protectedProcedure
    .meta({
      mcp: {
        name: "set_room_placements",
        title: "Curate room 3D placement",
        description:
          "Set how a room's artworks hang in 3D: per artwork, choose a wall (north/south/east/west), a normalized 0–1 offset along that wall (0 = start, 1 = end), a display scale (1 = natural size), and optionally a private note. Only artworks already hung in the room are affected. Each field is a partial patch — omit to leave it, pass null to clear it back to the automatic layout. Hang order still comes from set_room_artworks.",
        idempotent: true,
      },
    })
    .input(
      z.object({
        roomId: z.string().min(1),
        placements: z.array(placementDetailSchema).min(1).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { exhibition: owner } = await requireOwnRoom(input.roomId, ctx.session.user.id);
      const hung = await db
        .select({ artworkId: placement.artworkId })
        .from(placement)
        .where(eq(placement.roomId, input.roomId));
      const hungIds = new Set(hung.map((p) => p.artworkId));

      // One patch per artwork, issued concurrently rather than awaited in
      // series; each targets a distinct row, so there's no contention.
      const updates = input.placements
        .filter((detail) => hungIds.has(detail.artworkId))
        .map((detail) => ({ detail, set: placementSetValues(detail) }))
        .filter(({ set }) => Object.keys(set).length > 0);
      await Promise.all(
        updates.map(({ detail, set }) =>
          db
            .update(placement)
            .set(set)
            .where(
              and(eq(placement.roomId, input.roomId), eq(placement.artworkId, detail.artworkId)),
            ),
        ),
      );
      await touchExhibition(owner.id);

      return {
        ok: true,
        artworkIds: updates.map(({ detail }) => detail.artworkId),
      };
    }),

  /** Read-only pre-publish check: surfaces hung works that won't render,
   * content gaps (missing story / dimensions / artist), any over-packed
   * curated wall and — for multi-room exhibitions — empty rooms. Owner-only. */
  lint: protectedProcedure
    .meta({
      mcp: {
        name: "lint_exhibition",
        title: "Lint an exhibition before publishing",
        description:
          "Validate an exhibition and report problems that would degrade the 3D render. Returns { ok, errorCount, warningCount, infoCount, findings[] }: errors are works that won't appear at all (deleted/unpublished/removed) or an exhibition with nothing displayable; warnings cover missing images, unparseable/absent real-world dimensions (the 3D size then guesses from image aspect), missing wall-label stories, empty rooms in a multi-room exhibition, and over-packed curated walls that would overlap; info flags works with no artist attribution. Each finding carries a roomId/roomName where relevant. ok is true when there are no errors. Run this before publish_exhibition.",
        readOnly: true,
      },
    })
    .input(z.object({ exhibitionId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const owner = await requireOwnExhibition(input.exhibitionId, ctx.session.user.id);
      const { rooms, placements } = await loadRoomsWithPlacements([owner.id]);
      const artMap = await loadLintArtworks(placements.map((p) => p.artworkId));
      const placementsByRoom = bucketBy(placements, (p) => p.roomId);
      return runLint({
        kind: rooms.length === 1 ? "gallery" : "museum",
        name: owner.name,
        rooms: rooms.map((r) => ({
          id: r.id,
          name: r.name,
          layout: r.layout,
          members: (placementsByRoom.get(r.id) ?? []).map((p) => ({
            artworkId: p.artworkId,
            artwork: artMap.get(p.artworkId) ?? null,
            wall: p.wall,
            wallOffset: p.wallOffset,
            scale: p.scale,
          })),
        })),
      });
    }),
});

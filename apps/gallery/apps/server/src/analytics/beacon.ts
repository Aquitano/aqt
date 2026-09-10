import { db } from "@aqt/gallery-db";
import {
  museumStat,
  type StatEntityKind,
  type StatMetric,
  statEntityKinds,
  statMetrics,
} from "@aqt/gallery-db/schema/analytics";
import { exhibition, placement, room } from "@aqt/gallery-db/schema/exhibition";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

export const beaconEventSchema = z.object({
  entityKind: z.enum(statEntityKinds),
  entityId: z.string().min(1).max(64),
  metric: z.enum(statMetrics),
  /** Only meaningful for `inspect_open`; ignored otherwise. */
  artworkId: z.string().min(1).max(64).optional(),
});

export type BeaconEvent = z.infer<typeof beaconEventSchema>;

/** One batch of anonymous visit events. Capped so a single beacon can't be
 * used to force an unbounded amount of upsert work. */
export const beaconBatchSchema = z.object({
  events: z.array(beaconEventSchema).min(1).max(50),
});

export type StatIncrement = {
  entityKind: StatEntityKind;
  entityId: string;
  metric: StatMetric;
  artworkId: string;
  count: number;
};

/** UTC day bucket (YYYY-MM-DD) for a `date` column. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Collapse a raw batch into per-(entity, metric, artwork) increments, dropping
 * events whose entity is not published. Pure — no database — so the folding and
 * filtering can be tested in isolation. `artworkId` is retained only for
 * `inspect_open`; every other metric collapses onto the empty string, matching
 * the storage shape and the unique index. An `inspect_open` naming an artwork
 * the entity doesn't contain is dropped, so junk ids can't spawn unbounded rows. */
export function planIncrements(
  events: BeaconEvent[],
  isPublished: (kind: StatEntityKind, id: string) => boolean,
  hasArtwork: (kind: StatEntityKind, entityId: string, artworkId: string) => boolean,
): StatIncrement[] {
  const byKey = new Map<string, StatIncrement>();
  for (const e of events) {
    if (!isPublished(e.entityKind, e.entityId)) continue;
    if (
      e.metric === "inspect_open" &&
      e.artworkId &&
      !hasArtwork(e.entityKind, e.entityId, e.artworkId)
    )
      continue;
    const artworkId = e.metric === "inspect_open" && e.artworkId ? e.artworkId : "";
    const key = `${e.entityKind}\0${e.entityId}\0${e.metric}\0${artworkId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byKey.set(key, {
        entityKind: e.entityKind,
        entityId: e.entityId,
        metric: e.metric,
        artworkId,
        count: 1,
      });
    }
  }
  return [...byKey.values()];
}

/** Which of the referenced entities exist AND are published — the only ones
 * whose events we count. Anything unpublished or unknown is silently dropped so
 * the endpoint never confirms whether an id exists. */
async function publishedEntities(events: BeaconEvent[]): Promise<Set<string>> {
  const ids = new Set(events.map((e) => e.entityId));
  const published = new Set<string>();
  if (ids.size === 0) return published;
  const rows = await db
    .select({ id: exhibition.id })
    .from(exhibition)
    .where(and(inArray(exhibition.id, [...ids]), eq(exhibition.isPublished, true)));
  for (const e of rows) published.add(`exhibition\0${e.id}`);
  return published;
}

/** The (entity, artwork) pairs an `inspect_open` may legitimately reference:
 * artworks actually hung in a published entity. Batched so only a handful of
 * queries run regardless of batch size; anything else is treated as a junk id
 * and dropped upstream, capping the rows a beacon can create. */
async function knownArtworks(events: BeaconEvent[]): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.metric === "inspect_open" && e.artworkId) ids.add(e.entityId);
  }

  const known = new Set<string>();
  if (ids.size === 0) return known;
  const placements = await db
    .select({
      exhibitionId: room.exhibitionId,
      artworkId: placement.artworkId,
    })
    .from(placement)
    .innerJoin(room, eq(placement.roomId, room.id))
    .where(inArray(room.exhibitionId, [...ids]));
  for (const p of placements) known.add(`exhibition\0${p.exhibitionId}\0${p.artworkId}`);
  return known;
}

/** Validate + fold a beacon batch, then upsert the day counters. Fire-and-
 * forget: failures are swallowed by the caller, never surfaced to the client. */
export async function recordBeaconEvents(events: BeaconEvent[]): Promise<void> {
  const [published, known] = await Promise.all([publishedEntities(events), knownArtworks(events)]);
  const increments = planIncrements(
    events,
    (kind, id) => published.has(`${kind}\0${id}`),
    (kind, entityId, artworkId) => known.has(`${kind}\0${entityId}\0${artworkId}`),
  );
  if (increments.length === 0) return;

  const day = utcDay();
  await Promise.all(
    increments.map((inc) =>
      db
        .insert(museumStat)
        .values({
          entityKind: inc.entityKind,
          entityId: inc.entityId,
          metric: inc.metric,
          artworkId: inc.artworkId,
          day,
          count: inc.count,
        })
        .onConflictDoUpdate({
          target: [
            museumStat.entityKind,
            museumStat.entityId,
            museumStat.metric,
            museumStat.artworkId,
            museumStat.day,
          ],
          set: { count: sql`${museumStat.count} + ${inc.count}` },
        }),
    ),
  );
}

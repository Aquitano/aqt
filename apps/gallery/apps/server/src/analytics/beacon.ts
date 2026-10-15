import { db } from "@aqt/gallery-db";
import { museumStat } from "@aqt/gallery-db/schema/analytics";
import { exhibition, placement, room } from "@aqt/gallery-db/schema/exhibition";
import { and, eq, inArray, sql } from "drizzle-orm";

import { type BeaconEvent, planIncrements, utcDay } from "./beacon-events";

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

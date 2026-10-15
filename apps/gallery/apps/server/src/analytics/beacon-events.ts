import {
  type StatEntityKind,
  type StatMetric,
  statEntityKinds,
  statMetrics,
} from "@aqt/gallery-db/schema/analytics";
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

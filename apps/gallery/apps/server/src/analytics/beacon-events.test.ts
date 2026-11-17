import { describe, expect, test } from "bun:test";

import { type BeaconEvent, planIncrements, utcDay } from "./beacon-events";

const publishAll = () => true;
const allowAllArtworks = () => true;

function evt(over: Partial<BeaconEvent> = {}): BeaconEvent {
  return {
    entityKind: "exhibition",
    entityId: "m1",
    metric: "page_view",
    ...over,
  };
}

describe("planIncrements", () => {
  test("separates metrics, entities and inspected artworks", () => {
    const result = planIncrements(
      [
        evt(),
        evt({ artworkId: "ignored" }),
        evt({ metric: "session_entered" }),
        evt({ metric: "inspect_open", artworkId: "a1" }),
        evt({ metric: "inspect_open", artworkId: "a1" }),
        evt({ metric: "inspect_open", artworkId: "a2" }),
        evt({ entityId: "e2", metric: "page_view" }),
      ],
      publishAll,
      allowAllArtworks,
    );
    const byKey = new Map(result.map((r) => [`${r.metric}:${r.artworkId}:${r.entityId}`, r.count]));
    expect(byKey).toEqual(
      new Map([
        ["page_view::m1", 2],
        ["session_entered::m1", 1],
        ["inspect_open:a1:m1", 2],
        ["inspect_open:a2:m1", 1],
        ["page_view::e2", 1],
      ]),
    );
  });

  test("drops events for unpublished or unknown entities", () => {
    const result = planIncrements(
      [evt({ entityId: "published" }), evt({ entityId: "draft" })],
      (_kind, id) => id === "published",
      allowAllArtworks,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.entityId).toBe("published");
  });

  test("validates the inspected artwork against its own entity", () => {
    const result = planIncrements(
      [
        evt({ entityId: "m1", metric: "inspect_open", artworkId: "a1" }),
        evt({ entityId: "m2", metric: "inspect_open", artworkId: "a1" }),
        evt({ entityId: "m1", metric: "inspect_open", artworkId: "unhung" }),
      ],
      publishAll,
      (_kind, entityId, artworkId) => entityId === "m1" && artworkId === "a1",
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.entityId).toBe("m1");
  });

  test("keeps inspect_open events that carry no artworkId", () => {
    const result = planIncrements([evt({ metric: "inspect_open" })], publishAll, () => false);
    expect(result).toHaveLength(1);
    expect(result[0]?.artworkId).toBe("");
  });
});

describe("utcDay", () => {
  test("formats a UTC day bucket", () => {
    expect(utcDay(new Date("2026-07-07T23:30:00Z"))).toBe("2026-07-07");
  });
});

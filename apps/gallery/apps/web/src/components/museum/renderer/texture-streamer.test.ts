import { describe, expect, test } from "vite-plus/test";

import {
  MAX_RESIDENT_FULL,
  type PlanInput,
  type PlanPainting,
  planTextureStreaming,
  type StreamLevel,
} from "./texture-streamer";

const MB = 1024 * 1024;

function painting(x: number, overrides: Partial<PlanPainting> = {}): PlanPainting {
  return {
    roomIndex: 0,
    x,
    z: 0,
    available: ["thumb", "mid", "full"],
    resident: {},
    loading: [],
    ...overrides,
  };
}

function plan(paintings: PlanPainting[], overrides: Partial<PlanInput> = {}) {
  return planTextureStreaming({
    paintings,
    player: { x: 0, z: 0 },
    nearRooms: new Set([0, 1, 2]),
    protectedIndices: new Set(),
    byteBudget: 256 * MB,
    ...overrides,
  });
}

const requested = (
  list: { index: number; level: StreamLevel }[],
  index: number,
  level: StreamLevel,
) => list.some((r) => r.index === index && r.level === level);

describe("planTextureStreaming", () => {
  test("mid hysteresis: 15 m keeps a resident mid but does not load a new one", () => {
    const result = plan([
      painting(15, { resident: { thumb: MB, mid: 4 * MB } }),
      painting(15, { resident: { thumb: MB } }),
    ]);
    expect(requested(result.evict, 0, "mid")).toBe(false);
    expect(requested(result.load, 1, "mid")).toBe(false);
    expect(requested(result.load, 1, "thumb")).toBe(false);
  });

  test("full is requested only for hovered/inspected and never exceeds MAX_RESIDENT_FULL", () => {
    const idle = plan([painting(2, { resident: { thumb: MB, mid: 4 * MB } })]);
    expect(requested(idle.load, 0, "full")).toBe(false);

    const paintings = Array.from({ length: MAX_RESIDENT_FULL }, (_, i) =>
      painting(4 + i, { resident: { thumb: MB, mid: 4 * MB, full: 16 * MB } }),
    );
    paintings.push(painting(1, { resident: { thumb: MB, mid: 4 * MB } }));
    const hovered = paintings.length - 1;
    const result = plan(paintings, { protectedIndices: new Set([hovered]) });

    expect(requested(result.load, hovered, "full")).toBe(true);
    const farthest = MAX_RESIDENT_FULL - 1;
    expect(requested(result.evict, farthest, "full")).toBe(true);
    const fullsAfter =
      paintings.filter((p) => p.resident.full !== undefined).length -
      result.evict.filter((r) => r.level === "full").length +
      result.load.filter((r) => r.level === "full").length;
    expect(fullsAfter).toBe(MAX_RESIDENT_FULL);
  });

  test("byte budget evicts the farthest unprotected texture first, never the hovered one", () => {
    const paintings = [
      painting(2, { resident: { thumb: MB, mid: 4 * MB } }),
      painting(6, { resident: { thumb: MB, mid: 4 * MB } }),
      painting(12, { resident: { thumb: MB, mid: 4 * MB, full: 16 * MB } }),
    ];
    const result = plan(paintings, {
      protectedIndices: new Set([2]),
      byteBudget: 30 * MB,
    });
    expect(result.evict[0]).toEqual({ index: 1, level: "mid" });
    expect(result.evict.some((r) => r.index === 2)).toBe(false);
    const stillResident = paintings.reduce(
      (sum, p, index) =>
        sum +
        Object.entries(p.resident).reduce(
          (acc, [level, bytes]) =>
            requested(result.evict, index, level as StreamLevel) ? acc : acc + bytes,
          0,
        ),
      0,
    );
    expect(stillResident).toBeLessThanOrEqual(30 * MB);
  });

  test("paintings outside the room window get no thumb and drop what they hold", () => {
    const result = plan(
      [
        painting(3, { roomIndex: 5 }),
        painting(3, { roomIndex: 6, resident: { thumb: MB } }),
        painting(3, { roomIndex: 1 }),
      ],
      { nearRooms: new Set([0, 1, 2]) },
    );
    expect(requested(result.load, 0, "thumb")).toBe(false);
    expect(requested(result.evict, 1, "thumb")).toBe(true);
    expect(requested(result.load, 2, "thumb")).toBe(true);
  });
});

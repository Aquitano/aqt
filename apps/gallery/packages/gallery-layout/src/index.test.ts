import { describe, expect, test } from "bun:test";

import { displaySize, parsePhysicalSize, slotWidth } from "./index";

describe("parsePhysicalSize", () => {
  const expectMeters = (dims: string, height: number, width: number) => {
    const parsed = parsePhysicalSize(dims);
    expect(parsed?.height).toBeCloseTo(height);
    expect(parsed?.width).toBeCloseTo(width);
  };

  test("plain centimetre string (height × width)", () => {
    expectMeters("73.7 × 92.1 cm", 0.737, 0.921);
  });

  test("Met-style inches-then-cm resolves to the metric figures", () => {
    expectMeters("29 x 36 1/4 in. (73.7 x 92.1 cm)", 0.737, 0.921);
  });

  test("Art-Institute-style cm-then-inches", () => {
    expectMeters("73.7 × 92.1 cm (29 × 36 1/4 in.)", 0.737, 0.921);
  });

  test("returns null without a cm figure", () => {
    expect(parsePhysicalSize("5 × 4 m")).toBeNull();
    expect(parsePhysicalSize("monumental")).toBeNull();
    expect(parsePhysicalSize(null)).toBeNull();
  });
});

describe("displaySize", () => {
  test("uses real dimensions when parseable, scaled by placement.scale", () => {
    expect(displaySize({ dimensions: "100 × 50 cm", scale: 2 })).toEqual({
      height: 2,
      width: 1,
    });
  });

  test("keeps the image aspect when it disagrees with the dimensions, preserving area", () => {
    // A portrait preview crop of a landscape panel: 2 x 1 m catalogued,
    // 1:2 image. Same wall area, no stretching.
    const s = displaySize({
      dimensions: "100 × 200 cm",
      imageWidth: 500,
      imageHeight: 1000,
    });
    expect(s.width / s.height).toBeCloseTo(0.5);
    expect(s.width * s.height).toBeCloseTo(2);
  });

  test("matching image and dimensions reproduce the real size", () => {
    expect(
      displaySize({
        dimensions: "100 × 50 cm",
        imageWidth: 50,
        imageHeight: 100,
      }),
    ).toEqual({ height: 1, width: 0.5 });
  });

  test("falls back to image aspect when dimensions are absent", () => {
    const s = displaySize({ imageWidth: 800, imageHeight: 400 });
    expect(s.height).toBeCloseTo(1.2);
    expect(s.width).toBeCloseTo(2.4);
  });

  test("defaults to a 4:3 portrait box with no data", () => {
    const s = displaySize({});
    expect(s.height).toBeCloseTo(1.2);
    expect(s.width).toBeCloseTo(1.6);
  });
});

describe("slotWidth", () => {
  test("adds the frame margin but never drops below the minimum slot", () => {
    expect(slotWidth(2)).toBeCloseTo(3.5); // 2 + 1.5
    expect(slotWidth(0.5)).toBeCloseTo(2.6); // floored at MIN_SLOT
  });
});

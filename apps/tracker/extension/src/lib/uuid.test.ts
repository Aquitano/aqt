import { describe, expect, test } from "bun:test";

import { uuidv7 } from "./uuid.ts";

describe("uuidv7", () => {
  test("is a version 7, RFC variant uuid", () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("starts with the millisecond timestamp", () => {
    const before = Date.now();
    const id = uuidv7();
    const stamp = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(Date.now());
  });
});

import { describe, expect, test } from "bun:test";

import { MAX_BACKOFF_MS, backoffMs } from "./backoff.ts";

describe("backoffMs", () => {
  test("doubles from two seconds and caps at five minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffMs)).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000,
    ]);
    expect(backoffMs(9)).toBe(MAX_BACKOFF_MS);
    expect(backoffMs(40)).toBe(MAX_BACKOFF_MS);
  });
});

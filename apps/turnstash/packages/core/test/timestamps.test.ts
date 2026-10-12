import { expect, test } from "bun:test";

import { isoTimestampOf } from "../src/timestamps.ts";

test("timestamps normalize strings and epoch milliseconds without inventing a fallback", () => {
  expect(isoTimestampOf("2026-09-21T12:00:00+02:00")).toBe("2026-09-21T10:00:00.000Z");
  expect(isoTimestampOf(1.9)).toBe("1970-01-01T00:00:00.001Z");
  expect(isoTimestampOf(0)).toBe("1970-01-01T00:00:00.000Z");
  for (const value of [undefined, null, {}, "yesterday", Number.NaN, 8.64e15 + 1])
    expect(isoTimestampOf(value)).toBeUndefined();
});

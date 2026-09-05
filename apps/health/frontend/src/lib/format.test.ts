import { describe, expect, it } from "vitest";

import { formatDateTime } from "./format";

describe("formatDateTime", () => {
  it("falls back for invalid numeric timestamps", () => {
    expect(formatDateTime(Number.NaN)).toBe("n/a");
  });
});

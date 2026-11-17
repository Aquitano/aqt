import { expect, test, vi } from "vite-plus/test";

import { uuidv7 } from "./uuid.ts";

test("encodes the millisecond timestamp in an RFC variant UUIDv7", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_123);
  try {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const stamp = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    expect(stamp).toBe(1_780_000_000_123);
  } finally {
    now.mockRestore();
  }
});

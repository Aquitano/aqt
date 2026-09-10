import { describe, expect, test } from "bun:test";

import { isPermanentFailure } from "./result.ts";

describe("isPermanentFailure", () => {
  test("keeps the outbox row for anything a retry or a login can fix", () => {
    expect([400, 404, 413, 422].map((s) => isPermanentFailure(s))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    // 401 and 403 are a login away; 403 is also what a proxy in front of
    // tracker returns for a lapsed session.
    expect([401, 403, 408, 429, 500, 503].map((s) => isPermanentFailure(s))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(isPermanentFailure(undefined)).toBe(false);
  });
});

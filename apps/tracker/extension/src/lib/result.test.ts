import { describe, expect, test } from "vite-plus/test";

import { isPermanentFailure } from "./result.ts";

describe("isPermanentFailure", () => {
  test("keeps the outbox row for anything a retry or a login can fix", () => {
    expect([400, 413, 422].map((s) => isPermanentFailure(s))).toEqual([true, true, true]);
    // 401 and 403 are a login away; 403 is also what a proxy in front of
    // tracker returns for a lapsed session. 404 and 405 are a wrong server URL.
    expect([401, 403, 404, 405, 408, 429, 500, 503].map((s) => isPermanentFailure(s))).toEqual([
      false,
      false,
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

import { describe, expect, test } from "bun:test";

import { isNewPageView, navigationTypeFor, spaNavigationType } from "./page-view.ts";

describe("isNewPageView", () => {
  const youtube = { query_keys: ["v"] };

  test("a different path is a new page view", () => {
    expect(isNewPageView("https://a.com/x", "https://a.com/y", undefined)).toBe(true);
    expect(isNewPageView("https://a.com/x", "https://b.com/x", undefined)).toBe(true);
  });

  test("hash-only and unlisted query changes are ignored", () => {
    expect(isNewPageView("https://a.com/x", "https://a.com/x#top", undefined)).toBe(false);
    expect(isNewPageView("https://a.com/x?a=1", "https://a.com/x?a=2", undefined)).toBe(false);
    expect(
      isNewPageView("https://y.com/watch?v=1&t=1", "https://y.com/watch?v=1&t=9", youtube),
    ).toBe(false);
  });

  test("a changed query key of the matching rule is a new page view", () => {
    expect(isNewPageView("https://y.com/watch?v=1", "https://y.com/watch?v=2", youtube)).toBe(true);
    expect(isNewPageView("https://y.com/watch", "https://y.com/watch?v=2", youtube)).toBe(true);
  });

  test("unparseable urls fall back to string comparison", () => {
    expect(isNewPageView("nope", "nope", undefined)).toBe(false);
    expect(isNewPageView("nope", "still nope", undefined)).toBe(true);
  });
});

describe("navigation types", () => {
  test("map transition types onto the wire vocabulary", () => {
    expect(navigationTypeFor("link", [])).toBe("load");
    expect(navigationTypeFor("typed", ["from_address_bar"])).toBe("load");
    expect(navigationTypeFor("reload", [])).toBe("reload");
    expect(navigationTypeFor("link", ["forward_back"])).toBe("back_forward");
    expect(spaNavigationType([])).toBe("spa");
    expect(spaNavigationType(["forward_back"])).toBe("back_forward");
  });
});

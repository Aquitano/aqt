import { describe, expect, test } from "vite-plus/test";

import { describeVisits, suggestionDescription } from "./recall.ts";

describe("suggestionDescription", () => {
  test("escapes what Chrome would parse as markup", () => {
    expect(
      suggestionDescription({
        title: `Tom & Jerry's <b>"best"</b>`,
        canonical_url: "https://example.org/a?b=1&c=2",
      }),
    ).toBe(
      "Tom &amp; Jerry&apos;s &lt;b&gt;&quot;best&quot;&lt;/b&gt; - <url>https://example.org/a?b=1&amp;c=2</url>",
    );
  });

  test("shows only the URL of an untitled record", () => {
    expect(suggestionDescription({ title: "", canonical_url: "https://example.org/" })).toBe(
      "<url>https://example.org/</url>",
    );
  });
});

describe("describeVisits", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");

  test("says how often, how recently and for how long", () => {
    const visits = { count: 3, last_at: "2026-09-30T10:00:00Z", active_seconds: 840 };
    expect(describeVisits("Seen", visits, now)).toBe(
      "Seen 3 times, last 2 days ago, 14 min in total",
    );
  });

  test("reads naturally for one visit, a long stay and a moment ago", () => {
    const visits = { count: 1, last_at: "2026-10-02T09:00:00Z", active_seconds: 5400 };
    expect(describeVisits("read", visits, now)).toBe("read once, 3 hours ago, 1 h 30 min in total");
    const glance = { count: 2, last_at: "2026-10-02T11:59:40Z", active_seconds: 20 };
    expect(describeVisits("read", glance, now)).toBe(
      "read 2 times, last just now, under 1 min in total",
    );
  });

  test("says nothing about a page never visited", () => {
    expect(
      describeVisits("Seen", { count: 0, last_at: null, active_seconds: 0 }, now),
    ).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";

import { type } from "arktype";

import { Rule, RulesResponse, hostMatches, matchRule } from "./rules.ts";

const rule = (overrides: Partial<Rule>): Rule => ({
  extractor: "github",
  version: 1,
  hosts: ["github.com"],
  path_regex: "^/[^/]+/[^/]+/(issues|pull)/\\d+",
  query_keys: [],
  dwell_ms: 5000,
  recapture: "never",
  max_bytes: 10 * 1024 * 1024,
  ...overrides,
});

describe("hostMatches", () => {
  test("exact host, case-insensitive", () => {
    expect(hostMatches("github.com", "GitHub.com")).toBe(true);
    expect(hostMatches("github.com", "gist.github.com")).toBe(false);
  });

  test("wildcard covers subdomains only, never the apex", () => {
    expect(hostMatches("*.example.com", "a.b.example.com")).toBe(true);
    expect(hostMatches("*.example.com", "example.com")).toBe(false);
    expect(hostMatches("*.example.com", "notexample.com")).toBe(false);
  });

  test("a bare star matches every host", () => {
    expect(hostMatches("*", "example.com")).toBe(true);
    expect(hostMatches("*", "a.b.c.example.co.uk")).toBe(true);
    expect(hostMatches("*", "localhost")).toBe(true);
  });
});

describe("matchRule", () => {
  const rules = [
    rule({}),
    rule({
      extractor: "youtube",
      hosts: ["*.youtube.com"],
      path_regex: "^/watch",
      query_keys: ["v"],
    }),
    rule({ extractor: "anything", hosts: ["x.com"], path_regex: "" }),
  ];

  test("matches host and path regex", () => {
    expect(matchRule(rules, new URL("https://github.com/wxt-dev/wxt/pull/12"))?.extractor).toBe(
      "github",
    );
    expect(matchRule(rules, new URL("https://github.com/wxt-dev/wxt"))).toBeUndefined();
    expect(matchRule(rules, new URL("https://www.youtube.com/watch?v=abc"))?.extractor).toBe(
      "youtube",
    );
    expect(matchRule(rules, new URL("https://www.youtube.com/feed"))).toBeUndefined();
  });

  test("an empty path regex matches every path", () => {
    expect(matchRule(rules, new URL("https://x.com/"))?.extractor).toBe("anything");
  });

  test("a wildcard rule catches what no specific rule claims", () => {
    const article = rule({ extractor: "article", hosts: ["*"], path_regex: "" });
    expect(matchRule([...rules, article], new URL("https://example.com/post"))?.extractor).toBe(
      "article",
    );
    expect(matchRule([...rules, article], new URL("https://github.com/a/b"))?.extractor).toBe(
      "article",
    );
  });

  test("a specific rule beats a wildcard one whatever the order", () => {
    const article = rule({ extractor: "article", hosts: ["*"], path_regex: "" });
    const url = new URL("https://github.com/wxt-dev/wxt/pull/12");
    expect(matchRule([...rules, article], url)?.extractor).toBe("github");
    expect(matchRule([article, ...rules], url)?.extractor).toBe("github");
  });

  test("an invalid regex never matches", () => {
    expect(
      matchRule([rule({ path_regex: "(" })], new URL("https://github.com/a/b")),
    ).toBeUndefined();
  });
});

describe("Rule decoding", () => {
  test("normalises Go nil slices and zero defaults", () => {
    const decoded = RulesResponse({
      rules: [
        {
          extractor: "x",
          version: 2,
          hosts: null,
          path_regex: "",
          query_keys: null,
          dwell_ms: 0,
          recapture: "never",
          max_bytes: 0,
        },
      ],
    });
    if (decoded instanceof type.errors) throw new Error(decoded.summary);
    expect(decoded[0]).toEqual({
      extractor: "x",
      version: 2,
      hosts: [],
      path_regex: "",
      query_keys: [],
      dwell_ms: 5000,
      recapture: "never",
      max_bytes: 10 * 1024 * 1024,
    });
  });
});

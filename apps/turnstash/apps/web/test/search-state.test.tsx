import { expect, test } from "bun:test";

import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";

import { HighlightedText } from "../src/components/HighlightedText";
import {
  decodeUrlSearch,
  highlightSegments,
  parseConversationSearch,
  parseSearchState,
  type SearchState,
} from "../src/search-state";

test("search and stable message URLs preserve reserved characters and validate filters", () => {
  const state = {
    q: '"a+b" & <img>',
    period: "all",
    provider: "claude",
    projectKey: "C:/project / &?#",
    role: "assistant",
  } satisfies SearchState;
  expect(
    parseSearchState(decodeUrlSearch(defaultParseSearch(defaultStringifySearch(state)))),
  ).toEqual(state);
  const linked = { message: "message / & ? # +", q: state.q };
  expect(
    parseConversationSearch(decodeUrlSearch(defaultParseSearch(defaultStringifySearch(linked)))),
  ).toEqual(linked);
  expect(
    parseConversationSearch(decodeUrlSearch(defaultParseSearch("?message=123&q=true"))),
  ).toEqual({ message: "123", q: "true" });
  expect(parseSearchState({ provider: "__proto__", period: "invalid", role: "admin" })).toEqual({});
  expect(parseSearchState(decodeUrlSearch(defaultParseSearch("?q=%20%20")))).toEqual({ q: "" });
  expect(parseSearchState({ q: "  compass  " })).toEqual({ q: "compass" });
  for (const message of ["", "nul\u0000key", "x".repeat(4097), { key: "object" }]) {
    expect(parseConversationSearch({ message }).invalidMessage).toBe(true);
  }
  expect(parseConversationSearch({})).toEqual({});
});

test("query highlights use literal text and escape transcript markup", () => {
  expect(
    highlightSegments("a+b A+B axb", "a+b")
      .filter((segment) => segment.matched)
      .map((segment) => segment.text),
  ).toEqual(["a+b", "A+B"]);
  expect(
    highlightSegments("a.b aXb", "a.b")
      .filter((segment) => segment.matched)
      .map((segment) => segment.text),
  ).toEqual(["a.b"]);
  expect(
    highlightSegments("go north north south", '"go north" OR -south')
      .filter((segment) => segment.matched)
      .map((segment) => segment.text),
  ).toEqual(["go north"]);
  const html = renderToStaticMarkup(
    <pre>
      <HighlightedText text={'<img src=x onerror="alert(1)"> a+b'} query="a+b" />
    </pre>,
  );
  expect(html).toContain("<mark>a+b</mark>");
});

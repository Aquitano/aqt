import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";

import { HighlightedText } from "../src/components/HighlightedText";
import {
  decodeUrlSearch,
  highlightSegments,
  parseConversationSearch,
  parseConversationListSearch,
  parseSearchState,
  parseLimitsSearch,
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

test("limits links preserve history and controls and reject invalid selections", () => {
  expect(
    parseLimitsSearch({ provider: "codex", week: -12, view: "drain", burn: "3h", future: "half" }),
  ).toEqual({ provider: "codex", week: -12, view: "drain", burn: "3h", future: "half" });
  expect(
    parseLimitsSearch({
      provider: "unknown",
      week: 1,
      view: "unknown",
      burn: "unknown",
      future: "unknown",
    }),
  ).toEqual({
    provider: undefined,

    week: undefined,
    view: undefined,
    burn: undefined,
    future: undefined,
  });
  expect(parseLimitsSearch({ week: -1.5 }).week).toBeUndefined();
});

test("drain links retain the selected provider and interval and reject invalid ranges", () => {
  const selected = {
    windows: { codex: 300, claude: 10080 },
    selectionProvider: "codex",
    from: 1_700_000_000_000,
    to: 1_700_003_600_000,
  };
  expect(
    parseLimitsSearch(decodeUrlSearch(defaultParseSearch(defaultStringifySearch(selected)))),
  ).toMatchObject(selected);
  expect(parseLimitsSearch({ ...selected, to: selected.from }).from).toBeUndefined();
  expect(parseLimitsSearch({ ...selected, selectionProvider: "unknown" }).from).toBeUndefined();
  expect(parseLimitsSearch({ windows: { codex: -1, claude: 300, unknown: 300 } }).windows).toEqual({
    claude: 300,
  });
});

test("conversation-list links retain submitted title and exact project filters", () => {
  const state = { q: "fix a+b & login", projectKey: "C:/project / &?#" };
  expect(
    parseConversationListSearch(decodeUrlSearch(defaultParseSearch(defaultStringifySearch(state)))),
  ).toEqual(state);
  expect(parseConversationListSearch({ q: "  login  ", projectKey: " leading-space" })).toEqual({
    q: "login",
    projectKey: " leading-space",
  });
  expect(
    parseConversationListSearch(decodeUrlSearch(defaultParseSearch("?q=123&projectKey=true"))),
  ).toEqual({ q: "123", projectKey: "true" });
  expect(parseConversationListSearch({ q: " ", projectKey: "" })).toEqual({});
  expect(parseConversationListSearch({ q: ["nested"], projectKey: { value: "nested" } })).toEqual(
    {},
  );
  expect(parseConversationListSearch({ q: "x".repeat(1025), projectKey: "nul\u0000key" })).toEqual(
    {},
  );
});

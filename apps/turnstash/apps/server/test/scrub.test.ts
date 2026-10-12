import { expect, test } from "bun:test";

import { scrubJson } from "../src/scrub.ts";

test("scrubJson replaces NUL in nested strings and leaves escaped backslashes alone", () => {
  const input = [
    {
      type: "text",
      text: "a\u0000b",
      note: "literal \\u0000 stays",
      nested: { list: ["x\u0000"] },
    },
  ];
  expect(scrubJson(input)).toEqual([
    { type: "text", text: "a�b", note: "literal \\u0000 stays", nested: { list: ["x�"] } },
  ]);
});

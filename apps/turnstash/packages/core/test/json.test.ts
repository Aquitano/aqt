import { expect, test } from "bun:test";

import {
  jsonArrayAt,
  jsonNumberAt,
  jsonObjectAt,
  jsonStringAt,
  parseJson,
  parseJsonObject,
} from "../src/json.ts";

test("JSON accessors skip invalid fields and preserve empty arrays and zero", () => {
  const source = { missing: null, empty: "", title: "hello", zero: 0, items: [], nested: {} };
  expect(jsonStringAt(source, "missing", "empty", "title")).toBe("hello");
  expect(jsonNumberAt(source, "missing", "zero")).toBe(0);
  expect(jsonArrayAt(source, "missing", "items")).toBe(source.items);
  expect(jsonObjectAt(source, "missing", "nested")).toBe(source.nested);
  expect(jsonStringAt([], "title")).toBeUndefined();
  expect(jsonNumberAt({ value: Number.POSITIVE_INFINITY }, "value")).toBeUndefined();
  expect(jsonArrayAt(undefined, "items")).toEqual([]);
  expect(jsonObjectAt({ value: [] }, "value")).toBeUndefined();
});

test("parseJson keeps documents with numbers past the double range", () => {
  expect(parseJsonObject('{"big": 1e400, "title": "hello"}')).toEqual({
    big: Number.POSITIVE_INFINITY,
    title: "hello",
  });
  expect(parseJson('{"title": ')).toBeUndefined();
});

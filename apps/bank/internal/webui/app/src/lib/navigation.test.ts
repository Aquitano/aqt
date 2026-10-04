/// <reference types="node" />

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  readLibraryFilters,
  readSelection,
  writeLibraryFilters,
  writeSelection,
} from "./navigation";

void test("submitted filters survive selection, view changes, and URL round trips without mixing views", () => {
  const params = new URLSearchParams("view=library&q=message+search");
  const filters = { q: "A title", source: "youtube", kind: "video" };
  writeLibraryFilters(params, "library", filters);
  writeLibraryFilters(params, "collections", { q: "Watch later", kind: "playlist" });
  writeSelection(params, { kind: "item", id: "item-1" });
  params.set("view", "collections");
  const restored = new URLSearchParams(params.toString());
  assert.deepEqual(readLibraryFilters(restored, "library"), filters);
  assert.deepEqual(readLibraryFilters(restored, "collections"), {
    q: "Watch later",
    kind: "playlist",
  });
  assert.deepEqual(readSelection(restored), { kind: "item", id: "item-1" });
  assert.equal(restored.get("q"), "message search");
  writeLibraryFilters(restored, "library", {});
  assert.deepEqual(readLibraryFilters(restored, "library"), {});
  assert.equal(readLibraryFilters(restored, "collections").q, "Watch later");
});

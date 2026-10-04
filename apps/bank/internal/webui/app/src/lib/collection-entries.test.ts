/// <reference types="node" />

import assert from "node:assert/strict";
import { test } from "node:test";

import { appendEntry, moveEntry } from "./collection-entries";

void test("moving the last visible row and appending keep the changed entries visible without losing repeated items", () => {
  const entries = Array.from({ length: 51 }, (_, index) => ({
    key: String(index),
    item_id: "repeated-item",
  }));
  const moved = moveEntry(entries, 49, 1, 50);
  assert.equal(moved.visible, 51);
  assert.equal(moved.entries[50].key, "49");
  assert.equal(moved.entries.length, 51);
  const added = appendEntry(moved.entries, { key: "new", item_id: "repeated-item" }, moved.visible);
  assert.equal(added.visible, 52);
  assert.equal(added.entries[added.visible - 1].key, "new");
  assert.equal(new Set(added.entries.map((entry) => entry.key)).size, 52);
  assert.equal(added.entries.filter((entry) => entry.item_id === "repeated-item").length, 52);
});

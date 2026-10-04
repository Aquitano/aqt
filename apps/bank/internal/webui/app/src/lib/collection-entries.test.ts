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
  assert.equal(added.visible, 51);
  assert.equal(added.entries[added.start + added.visible - 1].key, "new");
  assert.equal(new Set(added.entries.map((entry) => entry.key)).size, 52);
  assert.equal(added.entries.filter((entry) => entry.item_id === "repeated-item").length, 52);
});

void test("appending to a large collection shows its tail without expanding the rendered range", () => {
  const entries = Array.from({ length: 10_000 }, (_, index) => ({ key: String(index) }));
  const added = appendEntry(entries, { key: "new" }, 50);
  const rendered = added.entries.slice(added.start, added.start + added.visible);
  assert.equal(rendered.length, 50);
  assert.equal(rendered.at(-1)?.key, "new");
  assert.equal(added.entries.length, 10_001);
  assert.equal(entries.length, 10_000);
});

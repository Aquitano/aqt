/// <reference types="node" />

import assert from "node:assert/strict";
import { test } from "node:test";

import { QueryClient } from "@tanstack/react-query";

import { createDraft, isDirty, keepLatest, refreshDraft, saveDraft, type Draft } from "./draft";

void test("dirty draft cache survives library invalidation and keeps the original expected revision", async () => {
  const client = new QueryClient();
  const baseline = { notes: "Saved notes" };
  client.setQueryData(["draft", "tracking", "item-1"], {
    ...createDraft(baseline, 1),
    value: { notes: "My unsaved notes" },
  });
  client.setQueryData(["library", "item", "item-1"], baseline);
  await client.invalidateQueries({ queryKey: ["library"] });
  client.setQueryData(["library", "item", "item-1"], { notes: "New server notes" });
  const cached = client.getQueryData<Draft<typeof baseline>>(["draft", "tracking", "item-1"]);
  assert.ok(cached);
  assert.equal(cached.value.notes, "My unsaved notes");
  assert.equal(cached.revision, 1);
  assert.equal(refreshDraft(cached, { notes: "New server notes" }, 2), cached);
  client.clear();
});

void test("clean drafts refresh and a successful save retains edits made while saving", () => {
  const saved = { notes: "Saved" };
  const refreshed = refreshDraft(createDraft({ notes: "Old" }, 1), saved, 2);
  assert.equal(refreshed.revision, 2);
  assert.equal(isDirty(refreshed), false);
  const pending = { ...refreshed, value: { notes: "Edited during save" } };
  const committed = saveDraft(pending, { notes: "Submitted" }, 3, { notes: "Submitted" });
  assert.equal(committed.value.notes, "Edited during save");
  assert.equal(committed.baseline.notes, "Submitted");
  assert.equal(committed.revision, 3);
  assert.equal(isDirty(committed), true);
});

void test("a delayed save response cannot downgrade newer cached data or draft revisions", async () => {
  const client = new QueryClient();
  const key = ["library", "collection", "collection-1"];
  const submitted = { notes: "Submitted" };
  const response = { ...submitted, revision: 2 };
  const delayedSave = Promise.resolve(response).then((received) =>
    client.setQueryData<typeof response>(key, (current) => keepLatest(current, received)),
  );
  const latest = { notes: "Newer server edit", revision: 3 };
  client.setQueryData(key, latest);
  await delayedSave;
  assert.deepEqual(client.getQueryData(key), latest);
  const clean = createDraft({ notes: latest.notes }, latest.revision);
  assert.equal(saveDraft(clean, submitted, 2, submitted), clean);
  const dirty = { ...createDraft({ notes: "Original" }, 1), value: submitted };
  const accepted = saveDraft(dirty, submitted, 2, submitted);
  assert.equal(accepted.revision, 2);
  assert.ok(latest.revision > accepted.revision);
  assert.equal(keepLatest(undefined, response), response);
  client.clear();
});

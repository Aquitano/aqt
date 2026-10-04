import { type } from "arktype";

import { api, message, libraryFile, type SearchParams } from "@/lib/api";

const identity = { source: "string", account: "string", external_id: "string" } as const;
const provenance = type({ raw_ref: "string", locator: "string" });
const date = type({ value: "string", precision: "string" });
const state = type({
  revision: "number",
  status: "string",
  favorite: "boolean",
  "rating?": "number",
  notes: "string",
  tags: "string[] | null",
  "progress?": "number",
  "progress_unit?": "string",
});
const item = type({
  ...identity,
  id: "string",
  kind: "string",
  title: "string",
  description: "string",
  url: "string",
  provider: "string",
  provider_id: "string",
  creators: "string[] | null",
  series: "string",
  "album?": "string",
  "season?": "number",
  "episode?": "number",
  "year?": "number",
  "duration_seconds?": "number",
  provenance,
  "evidence?": provenance.array(),
  state,
  file_ids: "string[] | null",
});
const activity = type({
  ...identity,
  id: "string",
  item_id: "string",
  kind: "string",
  title: "string",
  occurred: date,
  "duration_seconds?": "number",
  provenance,
});
const entry = type({ item_id: "string", position: "number", external_id: "string", added: date });
const snapshot = type({
  id: "number",
  external_id: "string",
  captured: date,
  completeness: "string",
  provenance,
  entries: entry.array().or("null"),
});
const snapshotSummary = type({
  id: "number",
  external_id: "string",
  captured: date,
  completeness: "string",
  provenance,
  entry_count: "number",
});
const collection = type({
  ...identity,
  id: "string",
  kind: "string",
  title: "string",
  description: "string",
  personal: "boolean",
  revision: "number",
  "snapshot?": snapshot,
});
const collectionSummary = collection.omit("snapshot").and(type({ "snapshot?": snapshotSummary }));
const itemSummary = item.pick("id", "title", "kind", "source");
const mediaFileSchema = type({
  ...identity,
  id: "string",
  sha256: "string",
  filename: "string",
  mime_type: "string",
  size_bytes: "number",
  item_ids: "string[] | null",
  provenance,
  text_status: "string",
});
const page = type({
  ...identity,
  id: "string",
  path: "string",
  title: "string",
  body: "string",
  answers: "string[] | null",
  tags: "string[] | null",
  aliases: "string[] | null",
  content_hash: "string",
  revision: "string",
  sensitivity: "string",
  provenance,
});
const groups = {
  items: item.array(),
  activity: activity.array(),
  collections: collectionSummary.array(),
  files: mediaFileSchema.array(),
  pages: page.array(),
  coverage: "string[]",
} as const;
const importResult = type({
  items: "number",
  activity: "number",
  collections: "number",
  files: "number",
  pages: "number",
  "skipped?": "number",
  "ads?": "number",
  "diagnostics?": "string[] | null",
});
export type MediaItem = typeof item.infer;
export type MediaState = typeof state.infer;
export type Activity = typeof activity.infer;
export type Collection = typeof collection.infer;
export type CollectionEntry = typeof entry.infer;
export type ItemSummary = typeof itemSummary.infer;
export type SnapshotSummary = typeof snapshotSummary.infer;
export type MediaFile = typeof mediaFileSchema.infer;
export type KnowledgePage = typeof page.infer;
export type RecordedDate = typeof date.infer;
export type StateEdit = Omit<MediaState, "revision"> & { expected_revision: number };
export type CollectionEdit = Pick<Collection, "title" | "description"> & {
  expected_revision: number;
  entries: CollectionEntry[];
};
export interface LibraryFilters {
  q?: string;
  source?: string;
  account?: string;
  kind?: string;
  item_id?: string;
}
export const LIBRARY_PAGE = 50;
function query(filters: LibraryFilters, offset = 0) {
  const params = new URLSearchParams({ limit: String(LIBRARY_PAGE), offset: String(offset) });
  for (const key of ["q", "source", "account", "kind", "item_id"] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  return params;
}
function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
export function getItems(filters: LibraryFilters = {}, offset = 0) {
  return api(`/v1/library/items?${query(filters, offset)}`, item.array());
}
export function getItem(id: string) {
  return api(`/v1/library/items/${encodeURIComponent(id)}`, item);
}
export function getItemSummaries(ids: string[]) {
  return api("/v1/library/items/summaries", itemSummary.array(), json("POST", { ids }));
}
export function createItem(value: Pick<MediaItem, "title" | "kind" | "description" | "url">) {
  return api("/v1/library/items", item, json("POST", value));
}
export function saveState(id: string, edit: StateEdit) {
  return api(`/v1/library/items/${encodeURIComponent(id)}/state`, state, json("PUT", edit));
}
export function getActivity(filters: LibraryFilters = {}, offset = 0) {
  return api(`/v1/library/activity?${query(filters, offset)}`, activity.array());
}
export function getCollections(filters: LibraryFilters = {}, offset = 0) {
  return api(`/v1/library/collections?${query(filters, offset)}`, collectionSummary.array());
}
export function getCollection(id: string) {
  return api(`/v1/library/collections/${encodeURIComponent(id)}`, collection);
}
export function createCollection(
  value: Pick<Collection, "title" | "kind" | "description">,
  entries: CollectionEntry[] = [],
) {
  return api(
    "/v1/library/collections",
    collection,
    json("POST", {
      ...value,
      snapshot: {
        external_id: "",
        captured: { value: "", precision: "unknown" },
        completeness: "complete",
        provenance: { raw_ref: "", locator: "" },
        entries,
      },
    }),
  );
}
export function saveCollection(id: string, edit: CollectionEdit) {
  return api(`/v1/library/collections/${encodeURIComponent(id)}`, collection, json("PUT", edit));
}
export function getMediaFiles(filters: LibraryFilters = {}, offset = 0) {
  return api(`/v1/library/files?${query(filters, offset)}`, mediaFileSchema.array());
}
export function uploadFiles(files: File[], itemId?: string) {
  const body = new FormData();
  for (const file of files) body.append("file", file);
  if (itemId) body.append("item_id", itemId);
  return api("/v1/library/files", mediaFileSchema.array(), { method: "POST", body });
}
export function getPage(id: string) {
  return api(`/v1/library/pages/${encodeURIComponent(id)}`, page);
}
export function find(params: SearchParams, offset = 0) {
  const search = new URLSearchParams({ limit: String(LIBRARY_PAGE), offset: String(offset) });
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) search.set(key, String(value));
  return api(
    `/v1/find?${search}`,
    type({ messages: message.array(), attachments: libraryFile.array(), ...groups }),
  );
}
export function importLibrary(kind: string, file: File, account: string) {
  const body = new FormData();
  body.append("file", file);
  const params = new URLSearchParams();
  if (account.trim()) params.set("account", account.trim());
  return api(`/v1/import/${encodeURIComponent(kind)}?${params}`, importResult, {
    method: "POST",
    body,
  });
}

export function getCollectionSnapshots(id: string, offset = 0) {
  return api(
    `/v1/library/collections/${encodeURIComponent(id)}/snapshots?${query({}, offset)}`,
    snapshotSummary.array(),
  );
}
export function getCollectionSnapshot(id: string, snapshotId: number) {
  return api(`/v1/library/collections/${encodeURIComponent(id)}/snapshots/${snapshotId}`, snapshot);
}

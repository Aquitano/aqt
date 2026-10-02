import { type Type, type } from "arktype";

import { backoffMs } from "./backoff.ts";
import { CapturePayload, TrackerEvent } from "./events.ts";
import { uuidv7 } from "./uuid.ts";

const DB_NAME = "tracker-outbox";
const DB_VERSION = 1;

const RowBase = type({
  id: "string",
  created_at: "string",
  attempt_count: "number",
  next_attempt_at: "string",
});
export const EventRow = RowBase.and({ payload: TrackerEvent });
export type EventRow = typeof EventRow.infer;
export const CaptureRow = RowBase.and({ payload: CapturePayload });
export type CaptureRow = typeof CaptureRow.infer;

export type StoreName = "events" | "captures";

// A signed-out extension keeps enqueueing: 401 is retryable, so nothing evicts
// on failure, and the article fallback means every page is a capture. Captures
// carry whole documents, which is why they are bounded far lower than events.
const CAPACITY = { events: 10_000, captures: 200 } satisfies Record<StoreName, number>;

let connection: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore("events", { keyPath: "id" });
      request.result.createObjectStore("captures", { keyPath: "id" });
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("indexedDB open failed")),
    );
  });
  return connection;
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("indexedDB request failed")),
    );
  });
}

async function objectStore(name: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDatabase();
  return db.transaction(name, mode).objectStore(name);
}

function newRow<P>(payload: P) {
  const now = new Date().toISOString();
  return { id: uuidv7(), created_at: now, attempt_count: 0, next_attempt_at: now, payload };
}

/// Returns how many rows the insert evicted, so the caller can report them
/// the same way it reports rows the server rejected.
export async function enqueueEvent(event: TrackerEvent): Promise<number> {
  await settle((await objectStore("events", "readwrite")).put(newRow(event)));
  return trimToCapacity("events");
}

export async function enqueueCapture(payload: CapturePayload): Promise<number> {
  await settle((await objectStore("captures", "readwrite")).put(newRow(payload)));
  return trimToCapacity("captures");
}

async function trimToCapacity(name: StoreName): Promise<number> {
  const overflow = (await settle((await objectStore(name, "readonly")).count())) - CAPACITY[name];
  if (overflow <= 0) return 0;
  // Row ids are UUIDv7, so ascending key order is insertion order and the
  // first keys are the oldest.
  const oldest = (
    await settle((await objectStore(name, "readonly")).getAllKeys(null, overflow))
  ).filter((key): key is string => typeof key === "string");
  await removeRows(name, oldest);
  return oldest.length;
}

async function rows<t>(name: StoreName, schema: Type<t>): Promise<Type<t>["infer"][]> {
  const raw = await settle((await objectStore(name, "readonly")).getAll());
  return raw.flatMap((item) => {
    const decoded = schema(item);
    return decoded instanceof type.errors ? [] : [decoded];
  });
}

export async function dueEvents(limit: number): Promise<EventRow[]> {
  const now = new Date().toISOString();
  const ordered = (await rows("events", EventRow)).toSorted((a, b) => a.id.localeCompare(b.id));
  const blocked = ordered.findIndex((row) => row.next_attempt_at > now);
  return ordered.slice(0, blocked < 0 ? limit : Math.min(blocked, limit));
}

/// A cursor rather than `getAll`, because the caller only ever uploads the head
/// and a capture carries a whole document: reading every queued one would pull
/// hundreds of megabytes into the service worker on each pass.
export function nextDueCapture(): Promise<CaptureRow | undefined> {
  const now = new Date().toISOString();
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        // Row ids are UUIDv7, so the cursor walks oldest first.
        const request = db.transaction("captures", "readonly").objectStore("captures").openCursor();
        request.addEventListener("success", () => {
          const cursor = request.result;
          if (!cursor) return resolve(undefined);
          const decoded = CaptureRow(cursor.value);
          if (!(decoded instanceof type.errors) && decoded.next_attempt_at <= now) {
            return resolve(decoded);
          }
          cursor.continue();
        });
        request.addEventListener("error", () =>
          reject(request.error ?? new Error("indexedDB cursor failed")),
        );
      }),
  );
}

/// Drops everything queued about forgotten pages, so none of it reaches the
/// server again: page views whose URL `forgotten` accepts or whose id is in
/// `ids`, their spans and any other span in `ids`, and the captures of those
/// page views or of a forgotten URL. A page view that stays loses a forgotten
/// referrer.
export async function purge(
  forgotten: (url: string) => boolean,
  ids: ReadonlySet<string>,
): Promise<{ events: number; captures: number }> {
  const events = await rows("events", EventRow);
  const dropped = new Set(ids);
  for (const { payload } of events) {
    if (payload.type === "page_view" && forgotten(payload.url)) dropped.add(payload.id);
  }
  for (const { payload } of events) {
    if (payload.type === "span_start" && dropped.has(payload.page_view_id)) dropped.add(payload.id);
  }
  const doomed = events.filter((row) => dropped.has(row.payload.id));
  const unreferred = events.flatMap((row) => {
    if (row.payload.type !== "page_view" || dropped.has(row.payload.id)) return [];
    const { referrer, ...payload } = row.payload;
    return referrer !== undefined && forgotten(referrer) ? [{ ...row, payload }] : [];
  });
  const store = await objectStore("events", "readwrite");
  await Promise.all([
    ...doomed.map((row) => settle(store.delete(row.id))),
    ...unreferred.map((row) => settle(store.put(row))),
  ]);
  const captures = await purgeCaptures(
    ({ meta }) => dropped.has(meta.page_view_id) || forgotten(meta.url),
  );
  return { events: doomed.length, captures };
}

async function purgeCaptures(doomed: (capture: CapturePayload) => boolean): Promise<number> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("captures", "readwrite").objectStore("captures").openCursor();
    let removed = 0;
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor) return resolve(removed);
      const row = CaptureRow(cursor.value);
      if (!(row instanceof type.errors) && doomed(row.payload)) {
        cursor.delete();
        removed += 1;
      }
      cursor.continue();
    });
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("indexedDB cursor failed")),
    );
  });
}

export async function removeRows(name: StoreName, ids: readonly string[]): Promise<void> {
  const store = await objectStore(name, "readwrite");
  await Promise.all(ids.map((id) => settle(store.delete(id))));
}

export async function markFailed(
  name: StoreName,
  failed: readonly (EventRow | CaptureRow)[],
): Promise<void> {
  const store = await objectStore(name, "readwrite");
  await Promise.all(
    failed.map(async (row) => {
      // A full outbox may have evicted the row while its upload was in flight.
      if ((await settle(store.count(row.id))) === 0) return;
      const attempt_count = row.attempt_count + 1;
      const next_attempt_at = new Date(Date.now() + backoffMs(attempt_count)).toISOString();
      await settle(store.put({ ...row, attempt_count, next_attempt_at }));
    }),
  );
}

export async function pendingCounts(): Promise<{ events: number; captures: number }> {
  const [events, captures] = await Promise.all([
    settle((await objectStore("events", "readonly")).count()),
    settle((await objectStore("captures", "readonly")).count()),
  ]);
  return { events, captures };
}

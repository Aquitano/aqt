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

export async function enqueueEvent(event: TrackerEvent): Promise<void> {
  await settle((await objectStore("events", "readwrite")).put(newRow(event)));
}

export async function enqueueCapture(payload: CapturePayload): Promise<void> {
  await settle((await objectStore("captures", "readwrite")).put(newRow(payload)));
}

async function rows<t>(name: StoreName, schema: Type<t>): Promise<Type<t>["infer"][]> {
  const raw = await settle((await objectStore(name, "readonly")).getAll());
  return raw.flatMap((item) => {
    const decoded = schema(item);
    return decoded instanceof type.errors ? [] : [decoded];
  });
}

function due<R extends { id: string; next_attempt_at: string }>(list: R[], limit: number): R[] {
  const now = new Date().toISOString();
  return list
    .filter((row) => row.next_attempt_at <= now)
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit);
}

export async function dueEvents(limit: number): Promise<EventRow[]> {
  return due(await rows("events", EventRow), limit);
}

export async function dueCaptures(): Promise<CaptureRow[]> {
  return due(await rows("captures", CaptureRow), Number.POSITIVE_INFINITY);
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
    failed.map((row) => {
      const attempt_count = row.attempt_count + 1;
      const next_attempt_at = new Date(Date.now() + backoffMs(attempt_count)).toISOString();
      return settle(store.put({ ...row, attempt_count, next_attempt_at }));
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

import { useSyncExternalStore } from "react";

import { messageRef, type Attachment, type SearchParams } from "@/lib/api";
import type { LibraryFilters } from "@/lib/library-api";

export const VIEWS = [
  "library",
  "activity",
  "collections",
  "search",
  "browse",
  "contacts",
  "attachments",
  "media-files",
  "imports",
  "stats",
] as const;
export type View = (typeof VIEWS)[number];
export const isView = (value: string): value is View => VIEWS.some((view) => view === value);

export type Selection =
  | {
      kind: "thread";
      source: string;
      threadId: string;
      flashRef?: string;
    }
  | { kind: "item"; id: string }
  | { kind: "collection"; id: string }
  | { kind: "page"; id: string }
  | { kind: "message"; ref: string }
  | { kind: "contact"; name: string }
  | { kind: "file"; file: Attachment }
  | null;

const selectionKeys = [
  "item",
  "collection",
  "page",
  "message",
  "thread",
  "threadSource",
  "around",
  "contact",
  "file",
  "filename",
  "mime",
];
const searchKeys = [
  "q",
  "source",
  "from",
  "to",
  "person",
  "since",
  "until",
  "subject",
  "match",
  "mailbox_id",
  "has_attachment",
];
const locationEvent = "bank:navigate";

function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(locationEvent, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(locationEvent, listener);
  };
}

export function useLocation() {
  return useSyncExternalStore(subscribe, () => window.location.search);
}

let replacingHistory = false;

export function navigate(update: (params: URLSearchParams) => void) {
  const url = new URL(window.location.href);
  update(url.searchParams);
  if (url.href === window.location.href) return;
  if (replacingHistory) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  window.dispatchEvent(new Event(locationEvent));
}

export function replacingHistoryDuring(action: () => void) {
  replacingHistory = true;
  try {
    action();
  } finally {
    replacingHistory = false;
  }
}

export function readSelection(params: URLSearchParams): Selection {
  const item = params.get("item");
  if (item) return { kind: "item", id: item };
  const collection = params.get("collection");
  if (collection) return { kind: "collection", id: collection };
  const page = params.get("page");
  if (page) return { kind: "page", id: page };
  const message = params.get("message");
  if (message && messageRef.test(message)) return { kind: "message", ref: message };
  const contact = params.get("contact");
  if (contact) return { kind: "contact", name: contact };
  const file = params.get("file");
  if (file && /^[a-f0-9]{64}$/.test(file))
    return {
      kind: "file",
      file: {
        blake3: file,
        filename: params.get("filename") || file,
        mime_type: params.get("mime") || "",
      },
    };
  const source = params.get("threadSource");
  const threadId = params.get("thread");
  if (source && threadId) {
    const around = params.get("around");
    return {
      kind: "thread",
      source,
      threadId,
      flashRef: around && messageRef.test(around) ? around : undefined,
    };
  }
  return null;
}

export function writeSelection(params: URLSearchParams, selection: Selection) {
  for (const key of selectionKeys) params.delete(key);
  if (!selection) return;
  switch (selection.kind) {
    case "item":
    case "collection":
    case "page":
      params.set(selection.kind, selection.id);
      break;
    case "message":
      params.set("message", selection.ref);
      break;
    case "contact":
      params.set("contact", selection.name);
      break;
    case "file":
      params.set("file", selection.file.blake3);
      params.set("filename", selection.file.filename);
      if (selection.file.mime_type) params.set("mime", selection.file.mime_type);
      break;
    case "thread":
      params.set("thread", selection.threadId);
      params.set("threadSource", selection.source);
      if (selection.flashRef) params.set("around", selection.flashRef);
  }
}

export function select(selection: Selection) {
  navigate((params) => writeSelection(params, selection));
}

export function messageLink(ref: string) {
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set("message", ref);
  return url.href;
}

export function readSearch(params: URLSearchParams): SearchParams | null {
  if (!params.has("q")) return null;
  const match = params.get("match");
  const mailbox = Number(params.get("mailbox_id"));
  const attachment = params.get("has_attachment");
  return {
    q: params.get("q") || "",
    source: params.get("source") || undefined,
    from: params.get("from") || undefined,
    to: params.get("to") || undefined,
    person: params.get("person") || undefined,
    since: params.get("since") || undefined,
    until: params.get("until") || undefined,
    subject: params.get("subject") || undefined,
    match: match === "any" || match === "all" ? match : "best",
    mailbox_id: Number.isSafeInteger(mailbox) && mailbox > 0 ? mailbox : undefined,
    has_attachment: attachment === "true" ? true : attachment === "false" ? false : undefined,
  };
}

export function writeSearch(params: URLSearchParams, search: SearchParams) {
  for (const key of searchKeys) params.delete(key);
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined && key !== "offset") params.set(key, String(value));
  }
}

const libraryFilterKeys = ["q", "source", "account", "kind", "item_id"] as const;
type LibraryView = "library" | "activity" | "collections" | "media-files";

export function readLibraryFilters(params: URLSearchParams, view: LibraryView): LibraryFilters {
  const filters: LibraryFilters = {};
  for (const key of libraryFilterKeys) {
    const value = params.get(`${view}.${key}`);
    if (value) filters[key] = value;
  }
  return filters;
}

export function writeLibraryFilters(
  params: URLSearchParams,
  view: LibraryView,
  filters: LibraryFilters,
) {
  for (const key of libraryFilterKeys) {
    params.delete(`${view}.${key}`);
    const value = filters[key];
    if (value) params.set(`${view}.${key}`, value);
  }
}

export function useLibraryFilters(view: LibraryView) {
  const location = useLocation();
  const filters = readLibraryFilters(new URLSearchParams(location), view);
  function setFilters(next: LibraryFilters) {
    navigate((params) => writeLibraryFilters(params, view, next));
  }
  return [filters, setFilters] as const;
}

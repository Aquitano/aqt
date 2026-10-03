import { useSyncExternalStore } from "react";

import type { Attachment, SearchParams } from "@/lib/api";

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
      title?: string;
      flashId?: number;
      current?: boolean;
    }
  | { kind: "item"; id: string }
  | { kind: "collection"; id: string }
  | { kind: "page"; id: string }
  | { kind: "message"; id: number | string }
  | { kind: "contact"; name: string }
  | { kind: "mail-conflict"; source: string; key: string }
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
  "current",
  "choices",
  "contact",
  "conflict",
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
  "fuzzy",
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

export function navigate(update: (params: URLSearchParams) => void) {
  const url = new URL(window.location.href);
  update(url.searchParams);
  if (url.href === window.location.href) return;
  window.history.pushState(null, "", url);
  window.dispatchEvent(new Event(locationEvent));
}

export function readSelection(params: URLSearchParams): Selection {
  const item = params.get("item");
  if (item) return { kind: "item", id: item };
  const collection = params.get("collection");
  if (collection) return { kind: "collection", id: collection };
  const page = params.get("page");
  if (page) return { kind: "page", id: page };
  const message = params.get("message");
  if (message && (/^[a-f0-9]{12}$/.test(message) || /^[1-9]\d*$/.test(message)))
    return { kind: "message", id: message };
  const contact = params.get("contact");
  if (contact) return { kind: "contact", name: contact };
  const file = params.get("file");
  if (file && /^[a-f0-9]{64}$/.test(file))
    return {
      kind: "file",
      file: {
        sha256: file,
        filename: params.get("filename") || file,
        mime_type: params.get("mime") || "",
      },
    };
  const source = params.get("threadSource");
  const conflict = params.get("conflict");
  if (source && conflict) return { kind: "mail-conflict", source, key: conflict };
  const threadId = params.get("thread");
  if (source && threadId) {
    const around = Number(params.get("around"));
    return {
      kind: "thread",
      source,
      threadId,
      flashId: Number.isSafeInteger(around) && around > 0 ? around : undefined,
      current: params.get("current") === "true" || undefined,
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
      params.set("message", String(selection.id));
      break;
    case "contact":
      params.set("contact", selection.name);
      break;
    case "file":
      params.set("file", selection.file.sha256);
      params.set("filename", selection.file.filename);
      if (selection.file.mime_type) params.set("mime", selection.file.mime_type);
      break;
    case "thread":
      params.set("thread", selection.threadId);
      params.set("threadSource", selection.source);
      if (selection.flashId) params.set("around", String(selection.flashId));
      if (selection.current) params.set("current", "true");
      break;
    case "mail-conflict":
      params.set("conflict", selection.key);
      params.set("threadSource", selection.source);
  }
}

export function select(selection: Selection, choices?: string) {
  navigate((params) => {
    writeSelection(params, selection);
    if (choices) params.set("choices", choices);
  });
}

export function messageLink(ref: string) {
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set("message", ref);
  return url.href;
}

export function readSearch(params: URLSearchParams): SearchParams | null {
  if (!params.has("q")) return null;
  const match = params.get("match");
  const fuzzy = Number(params.get("fuzzy") ?? 1);
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
    match: match === "all" || match === "phrase" ? match : "any",
    fuzzy: Number.isInteger(fuzzy) && fuzzy >= 0 && fuzzy <= 2 ? fuzzy : 1,
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

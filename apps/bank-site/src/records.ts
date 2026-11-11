import type { Kind } from "./brand";

type Entry = { kind: Kind; date: string; from: string; text: string; same?: string };

/** Every sample record on the page. One ref names one record, wherever it appears. */
export const records = {
  "5b1e09d3c7f2": {
    kind: "mail",
    date: "2024-02-26",
    from: "Property office",
    text: "Handover moved to Thursday",
  },
  "0d94aa17e6b3": {
    kind: "library",
    date: "2024-02-26",
    from: "YouTube",
    text: "How to read a lease, 14 min",
  },
  "9be2f0416a3d": {
    kind: "chat",
    date: "2024-02-26",
    from: "Anna",
    text: "did you already transfer the deposit?",
  },
  "attic:7c1e5ab0": {
    kind: "drives",
    date: "2024-02-26",
    from: "archive-2",
    text: "/scans/2024/lease_signed.pdf",
    same: "a04d77e19c52",
  },
  "41c7d2ee90ab": { kind: "chat", date: "2024-02-26", from: "me", text: "doing it now" },
  a04d77e19c52: {
    kind: "mail",
    date: "2024-02-26",
    from: "me",
    text: "Fwd: Signed lease, 1 attachment",
    same: "attic:7c1e5ab0",
  },
  "attic:e3380b12": {
    kind: "drives",
    date: "2024-02-26",
    from: "archive-2",
    text: "/scans/2024/deposit_receipt.pdf",
  },
  d41b7e02f9a6: {
    kind: "ai",
    date: "2024-02-26",
    from: "assistant",
    text: "summarise the handover checklist",
  },
  "6f0c2ab94e15": {
    kind: "library",
    date: "2024-02-26",
    from: "notes",
    text: "handover-checklist.md",
  },
  "3fa91c20b7e4": {
    kind: "mail",
    date: "2024-02-26",
    from: "Property office",
    text: "Re: Deposit and key handover",
  },
  "77f0c1a2d458": { kind: "chat", date: "2024-02-26", from: "Anna", text: "keys on Thursday then" },
  "9a6b20fd3c41": {
    kind: "library",
    date: "2024-02-26",
    from: "Netflix",
    text: "Two episodes, 48 min",
  },

  c18f3d9e0a77: {
    kind: "ai",
    date: "2025-06-03",
    from: "coding session",
    text: "compare sqlite fts5 and paradedb",
  },
  e77a0c93d1f4: {
    kind: "library",
    date: "2025-06-04",
    from: "notes",
    text: "decision-search-engine.md",
    same: "attic:b2904fe1",
  },
  "51c0e7a2bb19": {
    kind: "mail",
    date: "2025-06-05",
    from: "Jonas",
    text: "Re: one database or two?",
  },
  "attic:b2904fe1": {
    kind: "drives",
    date: "2025-06-04",
    from: "laptop",
    text: "/notes/decision-search-engine.md",
    same: "e77a0c93d1f4",
  },

  "7d02b9c4e1aa": {
    kind: "mail",
    date: "2025-09-14",
    from: "Airline",
    text: "Your booking LIS, 2 attachments",
    same: "attic:4ea17f30",
  },
  "20c6f18d93b5": {
    kind: "chat",
    date: "2025-09-14",
    from: "Miguel",
    text: "send me your arrival time",
  },
  "attic:4ea17f30": {
    kind: "drives",
    date: "2025-09-15",
    from: "nas",
    text: "/travel/2025/boarding-pass.pdf",
    same: "7d02b9c4e1aa",
  },
  b83e1d5c7a20: { kind: "library", date: "2025-09-16", from: "notes", text: "lisbon-trip.md" },
} satisfies Record<string, Entry>;

export type RefId = keyof typeof records;

export const record = (id: RefId): Entry => records[id];

export const isRef = (id: string | undefined): id is RefId =>
  id !== undefined && Object.hasOwn(records, id);

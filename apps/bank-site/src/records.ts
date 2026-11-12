import type { Kind } from "./brand";

type Entry = { kind: Kind; date: string; from: string; text: string; same?: string };

/**
 * Every sample record on the page. One ref names one record, wherever it appears.
 * Messages are cited as `bank:`, files on drives as `attic:`, library records by their ID.
 * A library ID is a kind and 32 hex digits; the page shows the first eight.
 */
export const records = {
  "bank:5b1e09d3c7f2": {
    kind: "mail",
    date: "2024-02-26",
    from: "Property office",
    text: "Handover moved to Thursday",
  },
  "activity_4c9e21f0…": {
    kind: "library",
    date: "2024-02-26",
    from: "YouTube",
    text: "How to read a lease, 14 min",
  },
  "bank:9be2f0416a3d": {
    kind: "chat",
    date: "2024-02-26",
    from: "Anna",
    text: "did you already transfer the deposit?",
  },
  "attic:7c1e5ab04f2d9e61": {
    kind: "drives",
    date: "2024-02-26",
    from: "archive-2",
    text: "/scans/2024/lease_signed.pdf",
    same: "bank:a04d77e19c52",
  },
  "bank:41c7d2ee90ab": { kind: "chat", date: "2024-02-26", from: "me", text: "doing it now" },
  "bank:a04d77e19c52": {
    kind: "mail",
    date: "2024-02-26",
    from: "me",
    text: "Fwd: Signed lease, 1 attachment",
    same: "attic:7c1e5ab04f2d9e61",
  },
  "attic:e3380b12a95c07d4": {
    kind: "drives",
    date: "2024-02-26",
    from: "archive-2",
    text: "/scans/2024/deposit_receipt.pdf",
  },
  "bank:d41b7e02f9a6": {
    kind: "ai",
    date: "2024-02-26",
    from: "ChatGPT",
    text: "summarise the handover checklist",
  },
  "activity_b61d08e3…": {
    kind: "library",
    date: "2024-02-26",
    from: "YouTube",
    text: "Moving day checklist, 9 min",
  },
  "bank:3fa91c20b7e4": {
    kind: "mail",
    date: "2024-02-26",
    from: "Property office",
    text: "Re: Deposit and key handover",
  },
  "bank:77f0c1a2d458": {
    kind: "chat",
    date: "2024-02-26",
    from: "Anna",
    text: "keys on Thursday then",
  },
  "activity_e2057ac4…": {
    kind: "library",
    date: "2024-02-26",
    from: "Netflix",
    text: "Two episodes, 48 min",
  },

  "bank:e0a4517c9d2b": {
    kind: "mail",
    date: "2025-08-29",
    from: "Property office",
    text: "Lease ended, deposit returned in full",
  },

  "bank:c18f3d9e0a77": {
    kind: "ai",
    date: "2025-06-03",
    from: "Claude",
    text: "compare sqlite fts5 and paradedb",
  },
  "page_91f3c07b…": {
    kind: "library",
    date: "2025-06-04",
    from: "notes",
    text: "decision-search-engine.md",
  },
  "bank:51c0e7a2bb19": {
    kind: "mail",
    date: "2025-06-05",
    from: "Jonas",
    text: "Re: paradedb or two databases?",
  },
  "attic:b2904fe13c6a8d20": {
    kind: "drives",
    date: "2025-06-04",
    from: "laptop",
    text: "/notes/decision-search-engine.md",
  },

  "bank:7d02b9c4e1aa": {
    kind: "mail",
    date: "2025-09-14",
    from: "Airline",
    text: "Your booking LIS, 2 attachments",
    same: "attic:4ea17f3091be5c08",
  },
  "bank:20c6f18d93b5": {
    kind: "chat",
    date: "2025-09-14",
    from: "Miguel",
    text: "which flight do you land in lisbon?",
  },
  "attic:4ea17f3091be5c08": {
    kind: "drives",
    date: "2025-09-15",
    from: "nas",
    text: "/travel/2025/boarding-pass.pdf",
    same: "bank:7d02b9c4e1aa",
  },
  "page_3a7e60d4…": { kind: "library", date: "2025-09-16", from: "notes", text: "lisbon-trip.md" },
} satisfies Record<string, Entry>;

export type RefId = keyof typeof records;

export const record = (id: RefId): Entry => records[id];

export const isRef = (id: string | undefined): id is RefId =>
  id !== undefined && Object.hasOwn(records, id);

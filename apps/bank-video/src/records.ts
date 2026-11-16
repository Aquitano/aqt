export type Kind = "mail" | "chat" | "ai" | "library" | "drives";

export type Entry = {
  ref: string;
  kind: Kind;
  source: string;
  from: string;
  date: string;
  time: string;
  text: string;
  voice?: boolean;
};

const story = {
  receipt: {
    ref: "content:e3380b12a95c07d4",
    kind: "drives",
    source: "Drives",
    from: "archive-2",
    date: "2024-02-26",
    time: "17:48",
    text: "/scans/2024/deposit_receipt.pdf",
  },
  transfer: {
    ref: "msg:9be2f0416a3d5c81",
    kind: "chat",
    source: "WhatsApp",
    from: "Anna",
    date: "2024-02-26",
    time: "18:02",
    text: "did you already transfer the deposit?",
  },
  handover: {
    ref: "msg:3fa91c20b7e4d206",
    kind: "mail",
    source: "Gmail",
    from: "Property office",
    date: "2024-02-26",
    time: "09:14",
    text: "Re: Deposit and key handover",
  },
  keys: {
    ref: "msg:77f0c1a2d458b90e",
    kind: "chat",
    source: "WhatsApp",
    from: "Anna",
    date: "2024-02-26",
    time: "21:40",
    text: "keys on Thursday then",
  },
  lease: {
    ref: "content:7c1e5ab04f2d9e61",
    kind: "drives",
    source: "Drives",
    from: "archive-2",
    date: "2024-02-26",
    time: "16:20",
    text: "/scans/2024/lease_signed.pdf",
  },
  checklist: {
    ref: "msg:d41b7e02f9a6c3a5",
    kind: "ai",
    source: "ChatGPT",
    from: "me",
    date: "2024-02-26",
    time: "19:31",
    text: "summarise the handover checklist",
  },
  howto: {
    ref: "activity:4c9e21f0a7d3b5e1",
    kind: "library",
    source: "YouTube",
    from: "watched",
    date: "2024-02-26",
    time: "22:05",
    text: "How to read a lease",
  },
  ship: {
    ref: "msg:5e0c7b19a2f4d863",
    kind: "chat",
    source: "Discord",
    from: "mira",
    date: "2023-11-02",
    time: "22:51",
    text: "we should ship it on friday",
  },
  congrats: {
    ref: "msg:b7a2c90e14d6f358",
    kind: "chat",
    source: "LinkedIn",
    from: "Clara",
    date: "2022-05-18",
    time: "08:12",
    text: "congrats on the new role!",
  },
  engine: {
    ref: "msg:c18f3d9e0a77b2e4",
    kind: "ai",
    source: "Claude",
    from: "me",
    date: "2025-06-03",
    time: "14:27",
    text: "compare sqlite fts5 and paradedb",
  },
  episodes: {
    ref: "activity:e2057ac4b91f6d30",
    kind: "library",
    source: "Netflix",
    from: "watched",
    date: "2024-02-26",
    time: "23:10",
    text: "Two episodes, 48 min",
  },
  landing: {
    ref: "msg:20c6f18d93b5a71c",
    kind: "chat",
    source: "WhatsApp",
    from: "Miguel",
    date: "2025-09-14",
    time: "07:55",
    text: "voice note",
    voice: true,
  },
  answer: {
    ref: "msg:e0a4517c9d2b4f18",
    kind: "mail",
    source: "Gmail",
    from: "Property office",
    date: "2025-08-29",
    time: "10:31",
    text: "Lease ended, deposit returned in full.",
  },
} satisfies { [name: string]: Entry };

export type StoryId = keyof typeof story;

export const record = (id: StoryId): Entry => story[id];

/** The day the story starts on, as plotted in the day shot. */
export const day: Entry[] = [
  story.handover,
  story.lease,
  story.receipt,
  story.transfer,
  story.checklist,
  story.keys,
  story.howto,
  story.episodes,
];

export const totalRecords = 41_208;

export const mulberry = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const hex = (random: () => number, digits: number) =>
  Array.from({ length: digits }, () => Math.floor(random() * 16).toString(16)).join("");

type Template = [Kind, string, string, string];

const templates: [Template, ...Template[]] = [
  ["mail", "Gmail", "University", "Enrolment confirmed, winter term"],
  ["mail", "mbox", "Landlord", "Re: Flat viewing on Saturday"],
  ["mail", "Gmail", "Airline", "Your booking LIS, 2 attachments"],
  ["mail", "IMAP", "Jonas", "Re: paradedb or two databases?"],
  ["mail", "Gmail", "Bank", "Your statement for March"],
  ["mail", "mbox", "Tax office", "Assessment notice 2019"],
  ["mail", "Gmail", "Clara", "Re: thesis draft, chapter 3"],
  ["mail", "IMAP", "HR", "Offer letter, signed copy"],
  ["mail", "Gmail", "Property office", "Handover moved to Thursday"],
  ["mail", "Gmail", "me", "Fwd: Signed lease, 1 attachment"],
  ["chat", "WhatsApp", "Anna", "landed, see you at 7"],
  ["chat", "WhatsApp", "Mum", "call me when you're home"],
  ["chat", "WhatsApp", "Miguel", "which flight do you land in lisbon?"],
  ["chat", "Discord", "leo", "gg, one more round?"],
  ["chat", "Discord", "mira", "pushed the fix, can you review?"],
  ["chat", "LinkedIn", "Clara", "are you still in Vienna?"],
  ["chat", "WhatsApp", "Jonas", "photos from saturday"],
  ["ai", "ChatGPT", "me", "explain a lease break clause"],
  ["ai", "Claude", "me", "draft a reply to the landlord"],
  ["ai", "ChatGPT", "me", "translate this letter into German"],
  ["ai", "Claude", "me", "what is a siglum?"],
  ["library", "YouTube", "watched", "Lisbon in three days"],
  ["library", "Netflix", "watched", "One episode, 52 min"],
  ["library", "YouTube", "watched", "Moving day checklist"],
  ["library", "Documents", "notes", "decision-search-engine.md"],
  ["drives", "Drives", "archive-2", "/scans/2019/passport.pdf"],
  ["drives", "Drives", "nas", "/photos/2021/IMG_4410.HEIC"],
  ["drives", "Drives", "laptop", "/thesis/final_v7.docx"],
  ["drives", "Drives", "nas", "/travel/2025/boarding-pass.pdf"],
  ["drives", "Drives", "archive-2", "/scans/2016/rental_contract.pdf"],
];

const firstDay = Date.UTC(2014, 1, 3);
const lastDay = Date.UTC(2025, 7, 27);
const aiSince = Date.UTC(2022, 11, 1);
const msPerDay = 86_400_000;

export const refFor = (kind: Kind, random: () => number) => {
  if (kind === "drives") return `content:${hex(random, 16)}`;
  if (kind === "library") return `activity:${hex(random, 16)}`;
  return `msg:${hex(random, 16)}`;
};

const shuffle = <T>(list: readonly T[], random: () => number) =>
  list
    .map((item) => ({ item, key: random() }))
    .toSorted((x, y) => x.key - y.key)
    .map(({ item }) => item);

/** Made-up records in date order, for the cascade. Each template is used once before any repeats. */
export const stream = (count: number): Entry[] => {
  const random = mulberry(41_208);
  let deck: Template[] = [];
  const draw = (at: number): Template => {
    const fits = (t: Template) => t[0] !== "ai" || at >= aiSince;
    if (!deck.some(fits)) deck = shuffle(templates, random);
    const index = deck.findIndex(fits);
    const [picked] = deck.splice(Math.max(index, 0), 1);
    return picked ?? templates[0];
  };
  return Array.from({ length: count }, (_, i) => {
    const progress = (i + random() * 0.6) / count;
    const at = firstDay + Math.round(((lastDay - firstDay) * progress) / msPerDay) * msPerDay;
    const [kind, source, from, text] = draw(at);
    const minutes = Math.floor(random() * 24 * 60);
    return {
      ref: refFor(kind, random),
      kind,
      source,
      from,
      date: new Date(at).toISOString().slice(0, 10),
      time: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
      text,
    };
  });
};

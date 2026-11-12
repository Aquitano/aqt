// The product is called `bank` in the code today. Headings and sample output use
// the new name; `bin` is what a reader types into config they copy today.
export const brand = {
  name: "Siglum",
  cmd: "siglum",
  bin: "bank",
  repo: "https://github.com/Aquitano/aqt",
  docs: "https://github.com/Aquitano/aqt/tree/main/apps/bank",
  waitlistUrl: import.meta.env.VITE_WAITLIST_URL,
} as const;

export type Kind = "mail" | "chat" | "ai" | "library" | "drives";

/** Every source, in the order both diagrams list them. */
export const sources: { kind: Kind; name: string }[] = [
  { kind: "mail", name: "Gmail" },
  { kind: "mail", name: "IMAP" },
  { kind: "mail", name: "mbox, EML" },
  { kind: "chat", name: "WhatsApp" },
  { kind: "chat", name: "Discord" },
  { kind: "chat", name: "LinkedIn" },
  { kind: "ai", name: "ChatGPT" },
  { kind: "ai", name: "Claude" },
  { kind: "library", name: "YouTube" },
  { kind: "library", name: "Netflix" },
  { kind: "library", name: "Documents" },
  { kind: "drives", name: "Drives" },
];

export const kindColor = {
  mail: "text-mail",
  chat: "text-chat",
  ai: "text-ai",
  library: "text-library",
  drives: "text-drives",
} satisfies Record<Kind, string>;

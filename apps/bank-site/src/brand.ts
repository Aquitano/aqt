// The product is called `bank` in the code today. The site uses the new name;
// change it here and every command and heading follows.
export const brand = {
  name: "Siglum",
  cmd: "siglum",
  repo: "https://github.com/Aquitano/aqt",
  docs: "https://github.com/Aquitano/aqt/tree/main/apps/bank",
  waitlistUrl: import.meta.env.VITE_WAITLIST_URL,
} as const;

export type Kind = "mail" | "chat" | "ai" | "library" | "drives";

export const kindColor = {
  mail: "text-mail",
  chat: "text-chat",
  ai: "text-ai",
  library: "text-library",
  drives: "text-drives",
} satisfies Record<Kind, string>;

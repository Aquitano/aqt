import { useRef, useState, type ReactNode } from "react";

import { kindColor, type Kind } from "../brand";
import { gsap, ScrollTrigger, useGSAP } from "../motion";
import { Section } from "../parts";

const steps = [
  {
    id: "sources",
    name: "Sources",
    text: "Importers read exports and live accounts. Running one twice adds nothing twice. The original export is kept, so a better importer can replay it.",
  },
  {
    id: "records",
    name: "Records",
    text: "Each kind of data has its own Postgres schema. Rows are appended. A deleted message leaves a tombstone that says where it went.",
  },
  {
    id: "files",
    name: "Files",
    text: "A file is stored once, under its hash. One table maps the archive's hash to the drive catalogue's hash. That is how a mail attachment finds its copy on a drive.",
  },
  {
    id: "server",
    name: "Server",
    text: "One process serves every schema. The API document is generated from the handlers. A token can be read-only, limited to one schema, or both.",
  },
  {
    id: "readers",
    name: "Readers",
    text: "The command line, the web UI and agents call the same API. An agent gets it as MCP tools and writes refs into its notes.",
  },
] as const;

type Part = (typeof steps)[number]["id"];

const sources: [string, Kind][] = [
  ["gmail", "mail"],
  ["imap", "mail"],
  ["whatsapp", "chat"],
  ["discord", "chat"],
  ["ai chats", "ai"],
  ["documents", "library"],
  ["drives", "drives"],
];

function Box({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <span className="border-rule bg-panel block border px-2.5 py-1.5">
      {children}
      {sub ? <span className="text-faint block text-[0.68rem]">{sub}</span> : null}
    </span>
  );
}

const arrow = (
  <pre className="text-faint pl-10 leading-none" aria-hidden="true">
    {"│\n▼"}
  </pre>
);

export function Architecture() {
  const [active, setActive] = useState<Part>("sources");
  const stage = useRef<HTMLDivElement>(null);
  const pin = useRef<ScrollTrigger | null>(null);

  useGSAP(
    () => {
      const el = stage.current;
      if (!el) return;
      const top = (document.querySelector("nav")?.offsetHeight ?? 0) + 24;
      // Scrolling walks through the steps only while the whole diagram fits on screen.
      const fits = `(min-width: 1024px) and (min-height: ${el.offsetHeight + top + 24}px) and (prefers-reduced-motion: no-preference)`;
      gsap.matchMedia().add(fits, () => {
        pin.current = ScrollTrigger.create({
          trigger: el,
          start: `top ${top}px`,
          end: `+=${steps.length * 300}`,
          pin: true,
          onUpdate: (self) => {
            const step =
              steps[Math.min(steps.length - 1, Math.floor(self.progress * steps.length))];
            if (step) setActive(step.id);
          },
        });
        return () => {
          pin.current = null;
        };
      });
    },
    { scope: stage },
  );

  const choose = (index: number, id: Part) => {
    const trigger = pin.current;
    if (!trigger) return setActive(id);
    const y = trigger.start + ((index + 0.5) / steps.length) * (trigger.end - trigger.start);
    return window.scrollTo({ top: y, behavior: "smooth" });
  };

  const lit = (...parts: Part[]) =>
    `transition-opacity duration-300 ${parts.includes(active) ? "" : "opacity-25"}`;
  const text = steps.find((s) => s.id === active)?.text;

  return (
    <Section id="architecture" title="How it is built">
      <div
        ref={stage}
        className="grid gap-x-10 gap-y-6 lg:grid-cols-[8.5rem_minmax(0,1fr)_15rem] lg:items-start"
      >
        <ol className="mono flex flex-wrap gap-x-6 gap-y-2 text-[0.85rem] lg:grid lg:gap-y-0">
          {steps.map((step, i) => (
            <li key={step.id}>
              <button
                type="button"
                aria-current={step.id === active ? "step" : undefined}
                onClick={() => choose(i, step.id)}
                className="text-faint hover:text-ink aria-[current=step]:border-ink aria-[current=step]:text-ink cursor-pointer border-b border-transparent py-1 lg:w-full lg:border-b-0 lg:border-l lg:py-2 lg:pl-4 lg:text-left"
              >
                {step.name}
              </button>
            </li>
          ))}
        </ol>

        <p
          className="text-dim min-h-[7.5em] text-[1rem] leading-normal lg:order-3"
          aria-live="polite"
        >
          {text}
        </p>

        <div className="min-w-0 max-lg:overflow-x-auto lg:order-2">
          <div className="mono text-code grid min-w-[34rem] gap-y-1.5">
            <div className={`frame border-rule grid gap-2.5 border p-3 ${lit("sources")}`}>
              <span className="text-faint">Sources</span>
              <div className="flex flex-wrap gap-1.5">
                {sources.map(([name, kind]) => (
                  <span
                    key={name}
                    className={`border-rule bg-panel border px-2 py-1.5 ${kindColor[kind]}`}
                  >
                    {name}
                  </span>
                ))}
              </div>
            </div>
            {arrow}
            <div className="frame border-rule grid gap-2.5 border p-3">
              <span className={`text-faint ${lit("records", "files")}`}>
                One Postgres, with ParadeDB for search
              </span>
              <div className="grid grid-cols-2 gap-2.5">
                <div className="border-rule grid content-start gap-2 border border-dashed p-2.5">
                  <span className={lit("records")}>schema public, bank</span>
                  <span className={`text-dim ${lit("records")}`}>
                    messages threads contacts library text
                  </span>
                  <div className={lit("files")}>
                    <Box sub="SHA-256, stored on disk">blobs</Box>
                  </div>
                </div>
                <div className="border-rule grid content-start gap-2 border border-dashed p-2.5">
                  <span className={lit("records")}>schema attic, catalogue</span>
                  <span className={`text-dim ${lit("records")}`}>volumes entries text OCR</span>
                  <div className={lit("files")}>
                    <Box sub="BLAKE3, bytes stay on the drive">contents</Box>
                  </div>
                </div>
              </div>
              <span className={`border-ink border px-2.5 py-1.5 text-center ${lit("files")}`}>
                blob_digests: SHA-256 = BLAKE3
              </span>
            </div>
            {arrow}
            <div className={`frame border-rule grid gap-2.5 border p-3 ${lit("server")}`}>
              <span className="text-faint">One server</span>
              <div className="flex flex-wrap gap-2">
                <Box sub="archive and library">/v1</Box>
                <Box sub="catalogue">/attic/v1</Box>
                <Box sub="generated">openapi.json</Box>
                <Box sub="read-only, per schema">scoped tokens</Box>
              </div>
            </div>
            {arrow}
            <div className={`frame border-rule grid gap-2.5 border p-3 ${lit("readers")}`}>
              <span className="text-faint">Readers</span>
              <div className="flex flex-wrap gap-2">
                <Box sub="search, ref, timeline">command line</Box>
                <Box sub="browse and read">web UI</Box>
                <Box sub="MCP tools">agents</Box>
                <Box sub="cite refs">your notes</Box>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

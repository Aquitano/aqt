import { useRef, useState, type ReactNode } from "react";

import { kindColor, type Kind } from "../brand";
import { gsap, ScrollTrigger, useGSAP } from "../motion";

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

/** How much scrolling one step takes while the section is held in place. */
const stepScroll = 340;

export function Architecture() {
  const [active, setActive] = useState<Part>("sources");
  const section = useRef<HTMLElement>(null);
  const held = useRef<ScrollTrigger | null>(null);

  // `--p` counts steps passed, with fractions. The rail beside each step fills from it.
  const progress = (p: number) => section.current?.style.setProperty("--p", p.toFixed(3));

  useGSAP(
    () => {
      const el = section.current;
      if (!el) return;
      const top = (document.querySelector("nav")?.offsetHeight ?? 0) + 16;
      // Scrolling walks through the steps only while the whole section fits on screen.
      const fits = `(min-width: 1024px) and (min-height: ${el.offsetHeight + top + 16}px) and (prefers-reduced-motion: no-preference)`;
      gsap.matchMedia().add(fits, () => {
        const walk = { p: 0 };
        progress(0);
        const tween = gsap.to(walk, {
          p: steps.length,
          ease: "none",
          scrollTrigger: {
            trigger: el,
            start: `top ${top}px`,
            end: `+=${steps.length * stepScroll}`,
            pin: true,
            scrub: 0.6,
          },
          onUpdate: () => {
            progress(walk.p);
            const step = steps[Math.min(steps.length - 1, Math.floor(walk.p))];
            if (step) setActive(step.id);
          },
        });
        held.current = tween.scrollTrigger ?? null;
        return () => {
          held.current = null;
        };
      });
    },
    { scope: section },
  );

  const choose = (index: number, id: Part) => {
    const trigger = held.current;
    if (!trigger) {
      progress(index + 1);
      return setActive(id);
    }
    const y = trigger.start + ((index + 0.6) / steps.length) * (trigger.end - trigger.start);
    return window.scrollTo({ top: y, behavior: "smooth" });
  };

  const lit = (...parts: Part[]) =>
    `transition-opacity duration-500 ${parts.includes(active) ? "" : "opacity-25"}`;

  return (
    <section
      ref={section}
      id="architecture"
      aria-labelledby="architecture-title"
      className="border-rule scroll-mt-20 border-t pt-8"
    >
      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[19rem_minmax(0,1fr)] lg:items-start">
        <div className="grid gap-8">
          <h2 id="architecture-title" className="display text-[1.5rem] md:text-[1.9rem]">
            How it is built
          </h2>
          <ol>
            {steps.map((step, i) => (
              <li key={step.id} className="relative pl-5">
                <span aria-hidden="true" className="bg-rule absolute inset-y-0 left-0 w-px">
                  <span
                    className="bg-ink absolute inset-0 origin-top"
                    style={{ transform: `scaleY(clamp(0, calc(var(--p, 1) - ${i}), 1))` }}
                  />
                </span>
                <button
                  type="button"
                  aria-current={step.id === active ? "step" : undefined}
                  onClick={() => choose(i, step.id)}
                  className="mono text-faint hover:text-ink aria-[current=step]:text-ink w-full cursor-pointer py-2 text-left text-[0.9rem] transition-colors duration-300"
                >
                  {step.name}
                </button>
                <div
                  className={`grid transition-[grid-template-rows,opacity] duration-500 ease-out ${step.id === active ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
                >
                  <p className="text-dim overflow-hidden text-[1rem] leading-normal">
                    <span className="block pb-4">{step.text}</span>
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="min-w-0 max-lg:overflow-x-auto">
          <div className="mono text-code grid min-w-[34rem] gap-y-1.5">
            <div className={`frame border-rule grid gap-2.5 border p-3 ${lit("sources")}`}>
              <span className="text-faint">Sources</span>
              <div className="flex flex-wrap gap-2">
                {sources.map(([name, kind]) => (
                  <span
                    key={name}
                    className={`border-rule bg-panel border px-2.5 py-1.5 ${kindColor[kind]}`}
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
    </section>
  );
}

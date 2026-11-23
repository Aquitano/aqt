import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { kindColor, sources } from "../brand";
import { Down } from "../diagram";
import { gsap, ScrollTrigger, useGSAP } from "../motion";
import { Code, Heading, underNav, useWide } from "../parts";

const steps = [
  {
    id: "sources",
    name: "Sources",
    text: "Importers read exports and live accounts, and attic scans drives.",
  },
  {
    id: "records",
    name: "Records",
    text: "The archive and the drive catalogue each have their own schema. Search runs inside the database: ParadeDB BM25 for messages and drive files, Postgres full-text for the library.",
  },
  {
    id: "files",
    name: "Files",
    text: "The archive stores each attachment once, under its SHA\u2011256. One table maps that to the catalogue's BLAKE3, which is how an attachment finds its copies on drives.",
  },
  {
    id: "server",
    name: "Server",
    text: (
      <>
        One process serves both schemas over HTTP: the archive under <Code>/v1</Code>, the catalogue
        under <Code>/attic/v1</Code>. Every route under them needs a token;{" "}
        <Code>/openapi.json</Code> describes them without one.
      </>
    ),
  },
  {
    id: "readers",
    name: "Readers",
    text: (
      <>
        By default the command line and the MCP tools connect straight to Postgres. Set{" "}
        <Code>BANK_URL</Code> and they use the HTTP server instead. The web UI always uses the
        server.
      </>
    ),
  },
] as const;

type Part = (typeof steps)[number]["id"];

function Box({ children, sub, inline }: { children: ReactNode; sub: string; inline?: boolean }) {
  return (
    <span className="border-rule bg-panel block border px-2.5 py-1.5 text-left">
      {children}
      <span className={`text-faint text-[0.76rem] ${inline ? "ml-2.5" : "block"}`}>{sub}</span>
    </span>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="border-rule bg-panel border px-2 py-0.5 whitespace-nowrap">{children}</span>
  );
}

const tier =
  "frame border-rule grid gap-2 border p-2.5 transition-[opacity,border-color] duration-500";

const schemas = [
  ["archive", "public", "messages, attachments, contacts, library", "blobs", "SHA-256, on disk"],
  ["catalogue", "attic", "volumes, entries, text, OCR", "contents", "BLAKE3, on the drive"],
] as const;

/** How much scrolling one step takes while the section is held in place. */
const stepScroll = 240;

export function Architecture() {
  // Null shows every part at once: the reading when the section is not held for a walk.
  const [active, setActive] = useState<Part | null>(null);
  // The height the section has during the walk, when one step is open at a time.
  const [walkingHeight, setWalkingHeight] = useState(0);
  // During the walk one step is open at a time. Otherwise all stay open and the others only dim.
  const [walking, setWalking] = useState(false);
  const isWide = useWide();
  // Below `lg` the schema and digest detail starts closed, to keep the three routes in view.
  const [storage, setStorage] = useState(false);
  const section = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const held = useRef<ScrollTrigger | null>(null);

  // `--p` counts steps passed, with fractions. The rail beside each step fills from it.
  const progress = (p: number) => section.current?.style.setProperty("--p", p.toFixed(3));

  useLayoutEffect(() => {
    const el = section.current;
    const grid = body.current;
    if (!el || !grid) return undefined;
    const heights = (selector: string) =>
      [...el.querySelectorAll<HTMLElement>(selector)].map((part) => part.offsetHeight);
    const measure = () => {
      const head = grid.getBoundingClientRect().top - el.getBoundingClientRect().top;
      const names = heights("[data-step-name]").reduce((a, b) => a + b, 0);
      const list = names + Math.max(0, ...heights("[data-step-text]"));
      setWalkingHeight(Math.ceil(head + Math.max(list, ...heights("[data-diagram]"))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  useGSAP(
    () => {
      const el = section.current;
      if (!el || !walkingHeight) return;
      progress(steps.length);
      // One pixel less than the nav, so the section's top rule sits on the nav's bottom rule.
      const top = (document.querySelector("nav")?.offsetHeight ?? 0) - 1;
      // Scrolling walks through the steps only while the whole section fits on screen.
      const fits = `(min-width: 1024px) and (min-height: ${walkingHeight + top + 16}px) and (prefers-reduced-motion: no-preference)`;
      gsap.matchMedia().add(fits, () => {
        const walk = { p: 0 };
        progress(0);
        setActive("sources");
        setWalking(true);
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
          progress(steps.length);
          setActive(null);
          setWalking(false);
        };
      });
    },
    { scope: section, dependencies: [walkingHeight], revertOnUpdate: true },
  );

  const choose = (id: Part) => {
    const trigger = held.current;
    if (!trigger) return setActive(active === id ? null : id);
    const index = steps.findIndex((step) => step.id === id);
    const y = trigger.start + ((index + 0.6) / steps.length) * (trigger.end - trigger.start);
    return window.scrollTo({ top: y, behavior: "smooth" });
  };

  const lit = (...parts: Part[]) =>
    active === null || parts.some((part) => part === active) ? "" : "opacity-35";

  /** Below `lg` the step list is hidden and each step's text sits inside its part instead. */
  const note = (...parts: Part[]) =>
    steps
      .filter((step) => parts.some((id) => id === step.id))
      .map((step) => (
        <span
          key={step.id}
          className="text-dim block font-serif text-[0.97rem] leading-normal lg:hidden"
        >
          {step.text}
        </span>
      ));

  /**
   * A part of the diagram. From `lg` it is a button that opens its step. Below `lg` every step
   * is already written out inside its part, so it is a plain box.
   */
  const box = (id: Part, className: string, children: ReactNode) =>
    isWide ? (
      <button
        type="button"
        onClick={() => choose(id)}
        className={`hover:border-faint cursor-pointer text-left ${className} ${lit(id)}`}
      >
        {children}
      </button>
    ) : (
      <div className={className}>{children}</div>
    );

  /** An arrow between two tiers, lit with either of them. */
  const arrow = (parts: Part[], className = "", label?: string) => (
    <Down
      short
      label={label}
      className={`pl-10 transition-opacity duration-500 ${className} ${lit(...parts)}`}
    />
  );

  return (
    <section
      ref={section}
      id="architecture"
      aria-labelledby="architecture-title"
      className={`border-rule border-t pt-8 ${underNav}`}
    >
      <Heading
        id="architecture-title"
        title="How it is built."
        sub="Go, one Postgres with two schemas, and an HTTP API for the web UI and other machines."
      />

      <div
        ref={body}
        className="mt-10 grid gap-x-12 gap-y-8 lg:grid-cols-[19rem_minmax(0,1fr)] lg:items-start"
      >
        <ol className="max-lg:hidden">
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
                data-step-name
                aria-current={step.id === active ? "step" : undefined}
                onClick={() => choose(step.id)}
                className={`mono hover:text-ink aria-[current=step]:text-ink w-full cursor-pointer py-1.5 text-left text-[0.9rem] transition-colors duration-300 ${active === null ? "text-ink" : "text-faint"}`}
              >
                {step.name}
              </button>
              <div
                className={`grid transition-[grid-template-rows,opacity] duration-500 ease-out ${active === null || step.id === active ? "grid-rows-[1fr] opacity-100" : walking ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-35"}`}
              >
                <p className="text-dim overflow-hidden text-[0.97rem] leading-normal">
                  <span data-step-text className="block pb-3">
                    {step.text}
                  </span>
                </p>
              </div>
            </li>
          ))}
        </ol>

        <div
          data-diagram
          className="mono text-code grid min-w-0 gap-y-1 leading-normal lg:sticky lg:top-20"
        >
          {box(
            "sources",
            tier,
            <>
              <span className="text-faint">Sources</span>
              <span className="flex flex-wrap gap-1.5 max-lg:hidden">
                {sources.map((source) => (
                  <span key={source.name} className={kindColor[source.kind]}>
                    <Chip>{source.name}</Chip>
                  </span>
                ))}
              </span>
              {note("sources")}
            </>,
          )}
          {arrow(["sources", "records", "files"])}
          <div className="frame border-rule grid gap-2 border p-2.5">
            <span
              className={`text-faint transition-opacity duration-500 ${lit("records", "files")}`}
            >
              One Postgres, with ParadeDB for search
            </span>
            {note("records")}
            {isWide ? null : (
              <button
                type="button"
                aria-expanded={storage}
                onClick={() => setStorage(!storage)}
                className="-my-2 flex min-h-11 cursor-pointer items-center justify-between gap-4 text-left"
              >
                Storage details
                <span className="text-faint">{storage ? "hide" : "show"}</span>
              </button>
            )}
            <div className={`grid gap-2 sm:grid-cols-2 ${isWide || storage ? "" : "hidden"}`}>
              {schemas.map(([name, schema, tables, files, how]) => (
                <div
                  key={name}
                  className="border-rule grid content-between gap-1.5 border border-dashed p-2"
                >
                  {box(
                    "records",
                    "grid gap-1 transition-opacity duration-500",
                    <>
                      <span>
                        {name} <span className="text-faint">· schema {schema}</span>
                      </span>
                      <span className="text-dim">{tables}</span>
                    </>,
                  )}
                  {box(
                    "files",
                    "transition-opacity duration-500",
                    <Box inline sub={how}>
                      {files}
                    </Box>,
                  )}
                </div>
              ))}
            </div>
            {isWide || storage ? (
              <>
                {box(
                  "files",
                  "border-ink border px-2.5 py-1 !text-center transition-opacity duration-500",
                  "blob_digests: SHA-256 and BLAKE3 of the same bytes",
                )}
                {note("files")}
              </>
            ) : null}
          </div>
          {/* Two routes leave the database. Side by side from `sm`. Below it the server route
              comes first, and the local one follows as its own block with no arrow into it. */}
          <div className="grid gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="flex flex-col gap-y-1 max-sm:order-last max-sm:mt-4 sm:col-start-2 sm:row-span-4 sm:row-start-1">
              <span className="text-faint pb-1 sm:hidden">Or straight from Postgres:</span>
              <Down
                label="straight from Postgres"
                className={`pl-10 transition-opacity duration-500 max-sm:hidden ${lit("readers")}`}
              />
              {box(
                "readers",
                tier,
                <>
                  <span className="text-faint">Without BANK_URL</span>
                  <span className="flex flex-wrap gap-1.5">
                    {["command line", "agents"].map((name) => (
                      <Chip key={name}>{name}</Chip>
                    ))}
                  </span>
                  {note("readers")}
                </>,
              )}
            </div>
            {arrow(["records", "files", "server"], "sm:col-start-1")}
            {box(
              "server",
              `${tier} sm:col-start-1`,
              <>
                <span className="text-faint">One server</span>
                <span className="flex flex-wrap gap-1.5">
                  {["/v1", "/attic/v1", "openapi.json", "tokens"].map((name) => (
                    <Chip key={name}>{name}</Chip>
                  ))}
                </span>
                {note("server")}
              </>,
            )}
            {arrow(["server", "readers"], "sm:col-start-1", "over HTTP")}
            {box(
              "readers",
              `${tier} sm:col-start-1`,
              <>
                <span className="text-faint">Through the server</span>
                <span className="flex flex-wrap gap-1.5">
                  {["web UI", "command line", "agents"].map((name) => (
                    <Chip key={name}>{name}</Chip>
                  ))}
                </span>
              </>,
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

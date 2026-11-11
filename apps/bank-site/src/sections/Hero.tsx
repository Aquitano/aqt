import { useLayoutEffect, useRef, useState } from "react";

import { brand, kindColor, type Kind } from "../brand";
import { gsap, useGSAP, whenMoving } from "../motion";
import { Ref } from "../parts";
import { record, type RefId } from "../records";

const headline =
  "Ask about anything you ever wrote, received or saved. Get the answer with its source.";

type Example = { query: string; refs: RefId[] };

const examples: [Example, ...Example[]] = [
  {
    query: "lease deposit handover",
    refs: ["3fa91c20b7e4", "a04d77e19c52", "9be2f0416a3d", "attic:7c1e5ab0"],
  },
  {
    query: "why did we pick postgres",
    refs: ["c18f3d9e0a77", "e77a0c93d1f4", "51c0e7a2bb19", "attic:b2904fe1"],
  },
  {
    query: "flight confirmation lisbon",
    refs: ["7d02b9c4e1aa", "20c6f18d93b5", "attic:4ea17f30", "b83e1d5c7a20"],
  },
];

const typingTime = (query: string) => query.length * 0.035;

/** The prompt line reserves room for this one, so a shorter query never changes its height. */
const longest = examples.reduce((a, e) => (e.query.length > a.length ? e.query : a), "");

/** The two results that are the same file, as row numbers. */
function twins(refs: RefId[]): [number, number] {
  const first = refs.findIndex((id) => record(id).same !== undefined);
  const twin = refs.map((id) => record(id).same)[first];
  return [first, refs.findIndex((id) => id === twin)];
}

const kinds: Kind[] = [
  "mail",
  "chat",
  "mail",
  "drives",
  "library",
  "mail",
  "ai",
  "chat",
  "drives",
  "mail",
];
const dot = {
  mail: "bg-mail",
  chat: "bg-chat",
  ai: "bg-ai",
  library: "bg-library",
  drives: "bg-drives",
} satisfies Record<Kind, string>;

const hex = (n: number) => (Math.imul(n, 0x9e3779b1) >>> 0).toString(16).padStart(8, "0");

/** Made-up records for the stream behind the headline. */
const arriving = Array.from({ length: 22 }, (_, i) => {
  return { ref: (hex(i + 1) + hex(i + 101)).slice(0, 12), kind: kinds[i % kinds.length] ?? "mail" };
});

/** Records arriving, slowly, behind the headline. */
function Stream() {
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      whenMoving(() => {
        gsap.to("[data-stream]", { yPercent: -50, duration: 80, ease: "none", repeat: -1 });
      });
    },
    { scope },
  );

  return (
    <div
      ref={scope}
      aria-hidden="true"
      className="mono text-code pointer-events-none absolute inset-y-0 right-0 hidden w-[19rem] overflow-hidden [mask-image:linear-gradient(transparent,black_30%,black_70%,transparent)] opacity-45 lg:block"
    >
      <ul data-stream>
        {[...arriving, ...arriving].map((row, i) => (
          <li
            key={`${row.ref}-${i < arriving.length ? "a" : "b"}`}
            className="flex items-center justify-end gap-4 py-1.5"
          >
            <span className="text-faint">{row.ref}</span>
            <span className={`w-[4.5rem] ${kindColor[row.kind]}`}>{row.kind}</span>
            <span className={`size-1.5 rounded-full ${dot[row.kind]}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One example's rows. Every example sits in the same grid cell, so switching never changes the height. */
function Results({ example, active }: { example: Example; active: boolean }) {
  const scope = useRef<HTMLOListElement>(null);
  const [bracket, setBracket] = useState({ top: 0, height: 0 });
  const [first, second] = twins(example.refs);

  useLayoutEffect(() => {
    const el = scope.current;
    if (!el) return undefined;
    const measure = () => {
      const rows = el.querySelectorAll<HTMLElement>("[data-row]");
      const a = rows[first];
      const b = rows[second];
      if (!a || !b) return;
      const top = a.offsetTop + 11;
      setBracket({ top, height: b.offsetTop + 11 - top });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [first, second]);

  useGSAP(
    () => {
      if (!active) return;
      whenMoving(() => {
        gsap
          .timeline({ delay: typingTime(example.query) + 0.15, defaults: { ease: "power2.out" } })
          .from("[data-row]", { opacity: 0, y: 8, duration: 0.35, stagger: 0.09 })
          .from(
            "[data-bracket]",
            { scaleY: 0, transformOrigin: "top", duration: 0.5, ease: "power3.inOut" },
            "+=0.1",
          )
          .from("[data-equal]", { opacity: 0, duration: 0.25 }, "-=0.1");
      });
    },
    { scope, dependencies: [active], revertOnUpdate: true },
  );

  return (
    <ol
      ref={scope}
      aria-hidden={!active}
      className={`relative col-start-1 row-start-1 grid content-start gap-y-3 pl-9 ${active ? "" : "invisible"}`}
    >
      <li
        aria-hidden="true"
        className="absolute left-2 w-3"
        style={{ top: bracket.top, height: bracket.height }}
      >
        <span data-bracket className="border-ink absolute inset-0 border-y border-l" />
        <span data-equal className="absolute inset-y-0 left-0 flex -translate-x-1/2 items-center">
          <span className="bg-panel py-1 leading-none">=</span>
        </span>
      </li>
      {example.refs.map((id) => {
        const row = record(id);
        return (
          <li
            key={id}
            data-row
            className="grid grid-cols-[4.2rem_minmax(0,1fr)] gap-x-4 lg:grid-cols-[4.2rem_8.8rem_6.6rem_8.5rem_minmax(0,1fr)]"
          >
            <span className={kindColor[row.kind]}>{row.kind}</span>
            <span>
              <Ref id={id} />
            </span>
            <span className="text-faint col-start-2 lg:col-start-auto">{row.date}</span>
            <span className="text-dim col-start-2 lg:col-start-auto">{row.from}</span>
            <span className="col-start-2 [overflow-wrap:anywhere] lg:col-start-auto">
              {row.text}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function Hero() {
  const [index, setIndex] = useState(0);
  const example = examples[index] ?? examples[0];
  const intro = useRef<HTMLDivElement>(null);
  const scope = useRef<HTMLParagraphElement>(null);
  const typed = useRef<HTMLSpanElement>(null);

  useGSAP(
    () => {
      whenMoving(() => {
        gsap.from("[data-word]", {
          opacity: 0,
          y: "0.18em",
          duration: 0.55,
          stagger: 0.03,
          ease: "power2.out",
        });
      });
    },
    { scope: intro },
  );

  useGSAP(
    () => {
      const el = typed.current;
      if (!el) return;
      el.textContent = example.query;
      whenMoving(() => {
        const count = { n: 0 };
        el.textContent = "";
        gsap.to(count, {
          n: example.query.length,
          duration: typingTime(example.query),
          ease: "none",
          onUpdate: () => {
            el.textContent = example.query.slice(0, Math.round(count.n));
          },
        });
        return () => {
          el.textContent = example.query;
        };
      });
    },
    { scope, dependencies: [index], revertOnUpdate: true },
  );

  return (
    <header className="grid grid-cols-[minmax(0,1fr)] gap-12 pt-14 md:pt-20">
      <div ref={intro} className="relative grid gap-7">
        <Stream />
        <h1 className="display relative max-w-[21ch] text-[1.9rem] sm:text-[2.6rem] lg:text-[3.2rem]">
          {headline.split(" ").map((word, i) => (
            // The words never reorder, and two of them repeat.
            // oxlint-disable-next-line react/no-array-index-key
            <span key={i}>
              <span data-word className="inline-block">
                {word}
              </span>{" "}
            </span>
          ))}
        </h1>
        <p className="text-dim relative max-w-[54ch] text-[1.2rem]">
          {brand.name} is the data layer for your personal AI. It keeps your mail, chats, documents
          and drives in one place your agents can search, and every answer they give cites the
          record it came from.
        </p>
        <div className="mono relative flex flex-wrap items-center gap-x-8 gap-y-3 text-[0.85rem]">
          <a href="#run" className="btn">
            Run it yourself
          </a>
          <a
            href="#hosted"
            className="text-dim decoration-faint hover:text-ink py-3 underline underline-offset-4"
          >
            Wait for the hosted version
          </a>
        </div>
        <p className="mono text-code text-faint relative flex flex-wrap gap-x-6 gap-y-1">
          <span>Open source</span>
          <span>Self-hosted</span>
          <span>One Postgres</span>
        </p>
      </div>

      <div className="frame mono border-rule bg-panel text-code min-w-0 border">
        <p ref={scope} className="border-rule grid border-b px-4 py-3 sm:px-6">
          <span className="sr-only">{`${brand.cmd} search "${example.query}"`}</span>
          <span aria-hidden="true" className="invisible col-start-1 row-start-1">
            $ {brand.cmd} search "{longest}"
            <span className="caret" />
          </span>
          <span aria-hidden="true" className="col-start-1 row-start-1">
            <span className="text-faint select-none">$ </span>
            {brand.cmd} search "<span ref={typed} />"
            <span className="caret" />
          </span>
        </p>

        <div className="grid px-4 py-5 sm:px-6">
          {examples.map((e, i) => (
            <Results key={e.query} example={e} active={i === index} />
          ))}
        </div>

        <div className="border-rule flex flex-wrap items-baseline gap-x-6 gap-y-2 border-t px-4 py-3 sm:px-6">
          <span className="text-faint">Try another</span>
          {examples.map((e, i) => (
            <button
              key={e.query}
              type="button"
              aria-pressed={i === index}
              onClick={() => setIndex(i)}
              className="text-dim hover:text-ink aria-pressed:text-ink cursor-pointer text-left underline-offset-4 aria-pressed:underline"
            >
              {e.query}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

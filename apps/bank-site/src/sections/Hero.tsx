import { useLayoutEffect, useRef, useState } from "react";

import { brand, kindColor, type Kind } from "../brand";
import { gsap, useGSAP, whenMoving } from "../motion";

type Row = { kind: Kind; ref: string; date: string; from: string; text: string };
type Example = { query: string; rows: Row[]; same: [number, number] };

const examples: [Example, ...Example[]] = [
  {
    query: "lease deposit handover",
    rows: [
      {
        kind: "mail",
        ref: "3fa91c20b7e4",
        date: "2024-02-26",
        from: "Property office",
        text: "Re: Deposit and key handover",
      },
      {
        kind: "mail",
        ref: "a04d77e19c52",
        date: "2024-02-26",
        from: "me",
        text: "Fwd: Signed lease, 1 attachment",
      },
      {
        kind: "chat",
        ref: "9be2f0416a3d",
        date: "2024-02-26",
        from: "Anna",
        text: "did you already transfer the deposit?",
      },
      {
        kind: "drives",
        ref: "attic:7c1e5ab0",
        date: "2024-02-26",
        from: "archive-2",
        text: "/scans/2024/lease_signed.pdf",
      },
    ],
    same: [1, 3],
  },
  {
    query: "why did we pick postgres",
    rows: [
      {
        kind: "ai",
        ref: "c18f3d9e0a77",
        date: "2025-06-03",
        from: "coding session",
        text: "compare sqlite fts5 and paradedb",
      },
      {
        kind: "library",
        ref: "e77a0c93d1f4",
        date: "2025-06-04",
        from: "notes",
        text: "decision-search-engine.md",
      },
      {
        kind: "mail",
        ref: "51c0e7a2bb19",
        date: "2025-06-05",
        from: "Jonas",
        text: "Re: one database or two?",
      },
      {
        kind: "drives",
        ref: "attic:b2904fe1",
        date: "2025-06-04",
        from: "laptop",
        text: "/notes/decision-search-engine.md",
      },
    ],
    same: [1, 3],
  },
  {
    query: "flight confirmation lisbon",
    rows: [
      {
        kind: "mail",
        ref: "7d02b9c4e1aa",
        date: "2025-09-14",
        from: "Airline",
        text: "Your booking LIS, 2 attachments",
      },
      {
        kind: "chat",
        ref: "20c6f18d93b5",
        date: "2025-09-14",
        from: "Miguel",
        text: "send me your arrival time",
      },
      {
        kind: "drives",
        ref: "attic:4ea17f30",
        date: "2025-09-15",
        from: "nas",
        text: "/travel/2025/boarding-pass.pdf",
      },
      {
        kind: "library",
        ref: "b83e1d5c7a20",
        date: "2025-09-16",
        from: "notes",
        text: "lisbon-trip.md",
      },
    ],
    same: [0, 2],
  },
];

const typingTime = (query: string) => query.length * 0.035;

/** The prompt line reserves room for this one, so a shorter query never changes its height. */
const longest = examples.reduce((a, e) => (e.query.length > a.length ? e.query : a), "");

/** One example's rows. Every example sits in the same grid cell, so switching never changes the height. */
function Results({ example, active }: { example: Example; active: boolean }) {
  const scope = useRef<HTMLDivElement>(null);
  const [bracket, setBracket] = useState({ top: 0, height: 0 });
  const [first, second] = example.same;

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
          .from("[data-same]", { opacity: 0, duration: 0.3 }, "-=0.15");
      });
    },
    { scope, dependencies: [active], revertOnUpdate: true },
  );

  return (
    <div
      ref={scope}
      aria-hidden={!active}
      className={`col-start-1 row-start-1 grid content-start gap-y-5 ${active ? "" : "invisible"}`}
    >
      <ol className="relative grid gap-y-3 pl-7">
        <li
          data-bracket
          aria-hidden="true"
          className="border-ink absolute left-0 w-3 border-y border-l"
          style={{ top: bracket.top, height: bracket.height }}
        />
        {example.rows.map((row) => (
          <li
            key={row.ref}
            data-row
            className="grid grid-cols-[4.2rem_minmax(0,1fr)] gap-x-4 lg:grid-cols-[4.2rem_8.8rem_6.6rem_8.5rem_minmax(0,1fr)]"
          >
            <span className={kindColor[row.kind]}>{row.kind}</span>
            <span className="ref">{row.ref}</span>
            <span className="text-faint col-start-2 lg:col-start-auto">{row.date}</span>
            <span className="text-dim col-start-2 lg:col-start-auto">{row.from}</span>
            <span className="col-start-2 [overflow-wrap:anywhere] lg:col-start-auto">
              {row.text}
            </span>
          </li>
        ))}
      </ol>
      <p data-same className="text-dim pl-7">
        same bytes{"  "}
        <span className="text-ink">{example.rows[first]?.ref}</span>
        {" = "}
        <span className="text-ink">{example.rows[second]?.ref}</span>
      </p>
    </div>
  );
}

export function Hero() {
  const [index, setIndex] = useState(0);
  const example = examples[index] ?? examples[0];
  const scope = useRef<HTMLParagraphElement>(null);
  const typed = useRef<HTMLSpanElement>(null);

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
      <div className="grid gap-7">
        <h1 className="display max-w-[24ch] text-[2rem] sm:text-[2.8rem] lg:text-[3.5rem]">
          Everything you wrote, received and saved, in one database your agents can cite.
        </h1>
        <p className="text-dim max-w-[52ch] text-[1.2rem]">
          Mail, chats, documents and drives, imported into one Postgres you run yourself.
        </p>
        <div className="mono flex flex-wrap items-center gap-x-8 gap-y-3 text-[0.85rem]">
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
          <span className="text-faint ml-auto">sample data</span>
        </div>
      </div>
    </header>
  );
}

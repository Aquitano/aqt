import { useLayoutEffect, useRef, useState } from "react";

import { brand, kindColor, type Kind } from "../brand";
import { gsap, riseLines, useGSAP, whenMoving } from "../motion";

type Row = { kind: Kind; ref: string; date: string; from: string; text: string };
type Example = { query: string; rows: Row[]; same: [number, number]; note: string };

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
    note: "The PDF attached to the mail and the scan on the drive are the same bytes. They are stored once and their text is read once.",
  },
  {
    query: "why did we pick postgres",
    rows: [
      {
        kind: "ai",
        ref: "c18f3d9e0a77",
        date: "2025-06-03",
        from: "coding session",
        text: "compare sqlite fts5 and paradedb for the archive",
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
        text: "/notes/decisions/decision-search-engine.md",
      },
    ],
    same: [1, 3],
    note: "The note in the library and the file on the laptop are the same bytes, so the answer cites one document, not two.",
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
        text: "send me your arrival time when you have it",
      },
      {
        kind: "drives",
        ref: "attic:4ea17f30",
        date: "2025-09-15",
        from: "nas",
        text: "/travel/2025/boarding-pass.pdf",
      },
    ],
    same: [0, 2],
    note: "The boarding pass on the NAS came out of that mail. One ref leads to the other.",
  },
];

export function Hero() {
  const [index, setIndex] = useState(0);
  const example = examples[index] ?? examples[0];
  const scope = useRef<HTMLDivElement>(null);
  const typed = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [bracket, setBracket] = useState({ top: 0, height: 0 });
  const intro = useRef<HTMLDivElement>(null);
  const opened = useRef(false);

  useGSAP(
    () => {
      whenMoving(() => {
        const heading = intro.current?.querySelector("h1");
        if (heading) riseLines(heading, { duration: 1.1, stagger: 0.11 });
        gsap.from("[data-after]", { opacity: 0, y: 10, duration: 0.6, stagger: 0.12, delay: 0.55 });
      });
    },
    { scope: intro },
  );

  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return undefined;
    const measure = () => {
      const rows = el.querySelectorAll<HTMLElement>("[data-row]");
      const a = rows[example.same[0]];
      const b = rows[example.same[1]];
      if (!a || !b) return;
      const top = a.offsetTop + 11;
      setBracket({ top, height: b.offsetTop + 11 - top });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [example]);

  useGSAP(
    () => {
      const el = typed.current;
      if (!el) return;
      el.textContent = example.query;
      whenMoving(() => {
        const count = { n: 0 };
        el.textContent = "";
        const delay = opened.current ? 0 : 1.1;
        opened.current = true;
        gsap
          .timeline({ delay, defaults: { ease: "power2.out" } })
          .to(count, {
            n: example.query.length,
            duration: example.query.length * 0.035,
            ease: "none",
            onUpdate: () => {
              el.textContent = example.query.slice(0, Math.round(count.n));
            },
          })
          .from("[data-row]", { opacity: 0, y: 8, duration: 0.35, stagger: 0.09 }, "+=0.15")
          .from(
            "[data-bracket]",
            { scaleY: 0, transformOrigin: "top", duration: 0.55, ease: "power3.inOut" },
            "+=0.1",
          )
          .from("[data-note]", { opacity: 0, duration: 0.4 }, "-=0.15");
        return () => {
          el.textContent = example.query;
        };
      });
    },
    { scope, dependencies: [index], revertOnUpdate: true },
  );

  return (
    <header className="grid grid-cols-[minmax(0,1fr)] gap-12 pt-14 md:pt-20">
      <div ref={intro} className="grid gap-7">
        <h1 className="display max-w-[24ch] text-[2rem] sm:text-[2.8rem] lg:text-[3.5rem]">
          Everything you wrote, received and saved, in one database your agents can cite.
        </h1>
        <p data-after className="text-dim max-w-[52ch] text-[1.2rem]">
          Mail, chats, documents and drives, imported into one Postgres you run yourself.
        </p>
        <div data-after className="mono flex flex-wrap items-center gap-x-8 gap-y-3 text-[0.85rem]">
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

      <div ref={scope} className="frame mono border-rule bg-panel text-code min-w-0 border">
        <p className="border-rule border-b px-4 py-3 sm:px-6">
          <span className="sr-only">{`${brand.cmd} search "${example.query}"`}</span>
          <span aria-hidden="true">
            <span className="text-faint select-none">$ </span>
            {brand.cmd} search "<span ref={typed} />
            <span className="caret" />"
          </span>
        </p>

        <div className="relative px-4 py-5 sm:px-6">
          <ol ref={list} className="relative grid gap-y-3 pl-7">
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
          <p
            data-note
            className="text-dim mt-6 max-w-[62ch] pl-7 font-serif text-[1rem] leading-normal"
          >
            {example.note}
          </p>
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

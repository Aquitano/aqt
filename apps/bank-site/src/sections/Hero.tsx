import { useLayoutEffect, useRef, useState } from "react";

import { brand, kindColor } from "../brand";
import { gsap, useGSAP, whenMoving } from "../motion";
import { Ref } from "../parts";
import { record, type RefId } from "../records";

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

/** The two results that hold the same bytes, as row numbers. */
function twins(refs: RefId[]): [number, number] {
  const first = refs.findIndex((id) => record(id).same !== undefined);
  const twin = refs.map((id) => record(id).same)[first];
  return [first, refs.findIndex((id) => id === twin)];
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
      className={`relative col-start-1 row-start-1 grid content-start gap-y-3 pl-8 ${active ? "" : "invisible"}`}
    >
      <li
        aria-hidden="true"
        className="absolute left-1 w-3"
        style={{ top: bracket.top, height: bracket.height }}
      >
        <span data-bracket className="border-ink absolute inset-0 border-y border-l" />
        <span
          data-equal
          className="bg-panel absolute top-1/2 -left-1.5 -translate-y-1/2 py-0.5 leading-none"
        >
          =
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
        </div>
      </div>
    </header>
  );
}

import { useRef, useState } from "react";

import { brand, kindColor, type Kind } from "../brand";
import { gsap, useGSAP, whenMoving } from "../motion";
import { Ref } from "../parts";
import { record, type RefId } from "../records";

const headline = "Search what you wrote, received and saved.";

type Example = { query: string; refs: RefId[] };

const examples: [Example, ...Example[]] = [
  {
    query: "lease deposit handover",
    refs: ["bank:e0a4517c9d2b", "bank:a04d77e19c52", "bank:9be2f0416a3d", "attic:7c1e5ab04f2d9e61"],
  },
  {
    query: "fts5 paradedb decision",
    refs: ["bank:c18f3d9e0a77", "bank:51c0e7a2bb19", "page_91f3c07b…", "attic:b2904fe13c6a8d20"],
  },
  {
    query: "flight confirmation lisbon",
    refs: ["bank:7d02b9c4e1aa", "bank:20c6f18d93b5", "page_3a7e60d4…", "attic:4ea17f3091be5c08"],
  },
];

const typingTime = (query: string) => query.length * 0.035;

/** The prompt line reserves room for this one, so a shorter query never changes its height. */
const longest = examples.reduce((a, e) => (e.query.length > a.length ? e.query : a), "");

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

/** Made-up records for the stream behind the headline, each in the form its kind is cited in. */
const arriving = Array.from({ length: 22 }, (_, i) => {
  const kind = kinds[i % kinds.length] ?? "mail";
  const digits = hex(i + 1) + hex(i + 101);
  if (kind === "drives") return { kind, ref: `attic:${digits}` };
  const short = digits.slice(0, 12);
  return { kind, ref: kind === "library" ? `activity_${digits.slice(0, 8)}…` : `bank:${short}` };
});

/** Records arriving, slowly, behind the headline. */
function Stream() {
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      whenMoving(() => {
        gsap.to("[data-stream]", {
          yPercent: -50,
          duration: 80,
          ease: "none",
          repeat: -1,
          scrollTrigger: { trigger: scope.current, toggleActions: "play pause resume pause" },
        });
      });
    },
    { scope },
  );

  return (
    <div
      ref={scope}
      aria-hidden="true"
      className="mono text-code pointer-events-none absolute inset-y-0 right-0 hidden w-[19rem] overflow-hidden [mask-image:linear-gradient(transparent,black_38%,black_62%,transparent)] opacity-60 xl:block"
    >
      <ul data-stream>
        {[...arriving, ...arriving].map((row, i) => (
          <li
            key={`${row.ref}-${i < arriving.length ? "a" : "b"}`}
            className="flex items-center justify-end gap-4 py-2"
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

  useGSAP(
    () => {
      if (!active) return;
      whenMoving(() => {
        gsap.from("[data-row]", {
          opacity: 0,
          y: 8,
          duration: 0.35,
          stagger: 0.09,
          ease: "power2.out",
          delay: typingTime(example.query) + 0.15,
        });
      });
    },
    { scope, dependencies: [active], revertOnUpdate: true },
  );

  return (
    <ol
      ref={scope}
      aria-hidden={!active}
      className={`col-start-1 row-start-1 grid content-start gap-y-3 ${active ? "" : "invisible"}`}
    >
      {example.refs.map((id) => {
        const row = record(id);
        return (
          <li
            key={id}
            data-row
            className="grid grid-cols-[4.2rem_minmax(0,1fr)] gap-x-4 lg:grid-cols-[4.2rem_13rem_6.6rem_8.5rem_minmax(0,1fr)]"
          >
            <span className={kindColor[row.kind]}>{row.kind}</span>
            <span>
              <Ref bare id={id} />
            </span>
            <span className="text-faint hidden lg:block">{row.date}</span>
            <span className="text-dim hidden lg:block">{row.from}</span>
            <span className="col-start-2 lg:col-start-auto">
              <span className="text-dim lg:hidden">{row.from}: </span>
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
    <header className="grid grid-cols-[minmax(0,1fr)] gap-14 pt-14 md:pt-24">
      <div ref={intro} className="relative grid gap-7 lg:py-6">
        <Stream />
        <h1 className="display relative max-w-[24ch] text-[1.9rem] sm:text-[2.5rem] lg:text-[3rem]">
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
        <p className="text-dim relative max-w-[50ch] text-[1.15rem]">
          Mail, chats, AI conversations, watch history and documents in one self-hosted archive,
          with a catalogue of your drives. Search it from a terminal, a browser or an agent, and
          cite any result by its ref.
        </p>
        <div className="mono relative flex flex-wrap items-center gap-x-6 gap-y-3 text-[0.85rem]">
          <a href="#run" className="btn">
            Run it yourself
          </a>
          <a
            href={brand.waitlistUrl ? "#hosted" : brand.docs}
            className="text-dim decoration-faint hover:text-ink py-3 underline underline-offset-4"
          >
            {brand.waitlistUrl ? "Join the hosted waitlist" : "Read the docs"}
          </a>
        </div>
      </div>

      <div className="frame mono border-rule bg-panel text-code min-w-0 border">
        <p
          ref={scope}
          className="border-rule grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 border-b px-4 py-3 sm:px-6"
        >
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
          <span className="text-faint col-start-2 row-start-1 whitespace-nowrap">
            sample data<span className="max-md:hidden"> · hover a ref</span>
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
              className="text-dim decoration-rule hover:text-ink aria-pressed:text-ink aria-pressed:decoration-ink cursor-pointer text-left underline underline-offset-4"
            >
              {e.query}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

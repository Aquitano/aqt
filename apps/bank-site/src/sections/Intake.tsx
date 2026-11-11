import { useLayoutEffect, useRef, useState } from "react";

import { kindColor, type Kind } from "../brand";
import { gsap, useGSAP, whenMoving } from "../motion";
import { Section } from "../parts";

const sources: { kind: Kind; name: string; as: string }[] = [
  { kind: "mail", name: "Gmail", as: "API sync, Takeout mbox" },
  { kind: "mail", name: "IMAP", as: "collected continuously" },
  { kind: "mail", name: "Mail files", as: ".eml, folder trees" },
  { kind: "chat", name: "WhatsApp", as: "chat export" },
  { kind: "chat", name: "Discord", as: "data package" },
  { kind: "chat", name: "LinkedIn", as: "data export" },
  { kind: "ai", name: "ChatGPT, Claude", as: "data export" },
  { kind: "library", name: "YouTube, Netflix", as: "watch history" },
  { kind: "library", name: "Documents", as: "upload, Markdown" },
  { kind: "drives", name: "Drives", as: "scanner, in review" },
];

const stroke = {
  mail: "var(--color-mail)",
  chat: "var(--color-chat)",
  ai: "var(--color-ai)",
  library: "var(--color-library)",
  drives: "var(--color-drives)",
} satisfies Record<Kind, string>;

const outputs = [
  ["search", "one query, every kind"],
  ["timeline", "a year, a month, a day"],
  ["refs", "a citation per record"],
  ["MCP tools", "the same, for agents"],
] as const;

/** Curves between a column of evenly spaced rows and one point, drawn in real pixels so dashes stay even. */
function Wires({ side, colors }: { side: "in" | "out"; colors: string[] }) {
  const svg = useRef<SVGSVGElement>(null);
  const [{ w, h }, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = svg.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const mid = h / 2;
  const paths = colors.map((color, i) => {
    const y = ((i + 0.5) / colors.length) * h;
    const d =
      side === "in"
        ? `M0,${y} C${w * 0.55},${y} ${w * 0.45},${mid} ${w},${mid}`
        : `M0,${mid} C${w * 0.55},${mid} ${w * 0.45},${y} ${w},${y}`;
    return { color, d, key: `${side}-${i}` };
  });

  return (
    <svg ref={svg} aria-hidden="true" className="hidden h-full w-full lg:block">
      {paths.map((p) => (
        <g key={p.key} fill="none" stroke={p.color}>
          <path
            data-wire={side}
            d={p.d}
            strokeWidth="1"
            pathLength="100"
            strokeDasharray="100"
            opacity="0.7"
          />
          <path
            data-pulse={side}
            d={p.d}
            strokeWidth="2.5"
            strokeLinecap="round"
            pathLength="100"
            strokeDasharray="2.5 97.5"
            opacity="0"
          />
        </g>
      ))}
    </svg>
  );
}

/** Short dashes that keep travelling along the wires once they are drawn. */
const flow = (side: "in" | "out") =>
  gsap.fromTo(
    `[data-pulse=${side}]`,
    { strokeDashoffset: 100, opacity: 1 },
    {
      strokeDashoffset: 0,
      duration: 2.4,
      ease: "none",
      immediateRender: false,
      stagger: { each: 0.31, repeat: -1, repeatDelay: 1.2 },
    },
  );

export function Intake() {
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      whenMoving(() => {
        gsap
          .timeline({ scrollTrigger: { trigger: scope.current, start: "top 72%", once: true } })
          .from("[data-wire=in]", {
            strokeDashoffset: 100,
            duration: 1,
            stagger: 0.05,
            ease: "power2.inOut",
          })
          .from(
            "[data-wire=out]",
            { strokeDashoffset: 100, duration: 0.7, stagger: 0.07, ease: "power2.out" },
            "-=0.2",
          )
          .add(flow("in"))
          .add(flow("out"), "<1.2");
      });
    },
    { scope },
  );

  return (
    <Section id="sources" title="What goes in">
      <div
        ref={scope}
        className="mono text-code grid items-stretch gap-y-6 lg:grid-cols-[minmax(0,15rem)_minmax(3rem,1fr)_minmax(0,14rem)_minmax(3rem,1fr)_minmax(0,13rem)]"
      >
        <ul className="grid grid-cols-2 gap-x-6 lg:grid-cols-1">
          {sources.map((s) => (
            <li key={s.name} data-source className="flex h-11 flex-col justify-center">
              <span className={kindColor[s.kind]}>{s.name}</span>
              <span className="text-faint text-[0.68rem]">{s.as}</span>
            </li>
          ))}
        </ul>

        <Wires side="in" colors={sources.map((s) => stroke[s.kind])} />

        <div
          data-core
          className="frame border-rule bg-panel grid content-center gap-3 self-center border p-5"
        >
          <span className="display text-[1.25rem]">one Postgres</span>
          <ul className="text-dim grid gap-1">
            <li>records, appended</li>
            <li>bytes, named by hash</li>
            <li>text and OCR</li>
            <li>BM25 index</li>
          </ul>
        </div>

        <Wires side="out" colors={outputs.map(() => "var(--color-ink)")} />

        <ul className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-1 lg:grid-rows-4 lg:gap-y-0">
          {outputs.map(([name, what]) => (
            <li key={name} className="flex flex-col justify-center lg:relative lg:pl-3">
              <span>{name}</span>
              <span className="text-faint text-[0.68rem] lg:absolute lg:top-1/2 lg:mt-3.5">
                {what}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

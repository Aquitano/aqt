import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useRef } from "react";

import { kindColor, type Kind } from "../brand";
import { Section } from "../parts";

gsap.registerPlugin(useGSAP, ScrollTrigger);

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
  { kind: "disks", name: "Drives", as: "scanner, in review" },
];

const stroke = {
  mail: "var(--color-mail)",
  chat: "var(--color-chat)",
  ai: "var(--color-ai)",
  library: "var(--color-library)",
  disks: "var(--color-disks)",
} satisfies Record<Kind, string>;

const outputs = [
  ["search", "one query, every kind"],
  ["timeline", "a year, a month, a day"],
  ["refs", "a citation per record"],
  ["MCP tools", "the same, for agents"],
] as const;

const rowY = (i: number, n: number) => ((i + 0.5) / n) * 100;

export function Intake() {
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap
          .timeline({ scrollTrigger: { trigger: scope.current, start: "top 70%", once: true } })
          .from("[data-wires=in]", {
            clipPath: "inset(0 100% 0 0)",
            duration: 1,
            ease: "power2.inOut",
          })
          .from("[data-core]", { opacity: 0.25, duration: 0.3 }, "-=0.25")
          .from(
            "[data-wires=out]",
            { clipPath: "inset(0 100% 0 0)", duration: 0.7, ease: "power2.out" },
            "-=0.05",
          );
      });
    },
    { scope },
  );

  return (
    <Section id="sources" title="Ten kinds of export in, one database out">
      <div
        ref={scope}
        className="mono text-code grid items-stretch gap-y-6 lg:grid-cols-[minmax(0,15rem)_minmax(3rem,1fr)_minmax(0,14rem)_minmax(3rem,1fr)_minmax(0,13rem)]"
      >
        <ul className="grid grid-cols-2 gap-x-6 lg:grid-cols-1">
          {sources.map((s) => (
            <li key={s.name} className="flex h-11 flex-col justify-center">
              <span className={kindColor[s.kind]}>{s.name}</span>
              <span className="text-faint text-[0.68rem]">{s.as}</span>
            </li>
          ))}
        </ul>

        <svg
          data-wires="in"
          aria-hidden="true"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="hidden h-full w-full lg:block"
        >
          {sources.map((s, i) => (
            <path
              key={s.name}
              d={`M0,${rowY(i, sources.length)} C55,${rowY(i, sources.length)} 45,50 100,50`}
              fill="none"
              stroke={stroke[s.kind]}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        <div data-core className="border-ink grid content-center gap-3 self-center border p-5">
          <span className="display text-[1.25rem]">one Postgres</span>
          <ul className="text-dim grid gap-1">
            <li>records, appended</li>
            <li>bytes, named by hash</li>
            <li>text and OCR</li>
            <li>BM25 index</li>
          </ul>
        </div>

        <svg
          data-wires="out"
          aria-hidden="true"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="hidden h-full w-full lg:block"
        >
          {outputs.map(([name], i) => (
            <path
              key={name}
              d={`M0,50 C55,50 45,${rowY(i, outputs.length)} 100,${rowY(i, outputs.length)}`}
              fill="none"
              stroke="var(--color-ink)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        <ul className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-1 lg:grid-rows-4 lg:gap-y-0">
          {outputs.map(([name, what]) => (
            <li key={name} className="flex flex-col justify-center">
              <span>{name}</span>
              <span className="text-faint text-[0.68rem]">{what}</span>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

import { Fragment, useLayoutEffect, useRef, useState } from "react";

import { brand, kindColor, sources, type Kind } from "../brand";
import { Down, Node, Up } from "../diagram";
import { gsap, useGSAP, whenMoving } from "../motion";
import { Cell, Cells, Section } from "../parts";

const runs = [
  { when: "first import", fresh: 41_208, known: 0 },
  { when: "second import", fresh: 0, known: 41_208 },
  { when: "a month later", fresh: 1_317, known: 41_208 },
] as const;

const stroke = {
  mail: "var(--color-mail)",
  chat: "var(--color-chat)",
  ai: "var(--color-ai)",
  library: "var(--color-library)",
  drives: "var(--color-drives)",
} satisfies Record<Kind, string>;

const outputs = [
  ["search", "every source at once"],
  ["timeline", "a year, month or day"],
  ["ref", "resolve a saved ref"],
  ["ui", "the archive in a browser"],
  ["mcp", "read-only tools for agents"],
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
    <svg ref={svg} aria-hidden="true" className="glow-line hidden h-full w-full lg:block">
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
            strokeDasharray="2.5 102.5"
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
    { strokeDashoffset: 2.5, opacity: 1 },
    {
      strokeDashoffset: -100,
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
          .timeline({
            scrollTrigger: {
              trigger: scope.current,
              start: "top 72%",
              end: "bottom top",
              toggleActions: "play pause resume pause",
            },
          })
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
    <Section
      id="sources"
      title="Exports, accounts and drives in one archive."
      sub="Gmail and IMAP sync from live accounts. Chats, AI conversations, watch history and mail archives come from each service's export. Documents are uploaded or indexed from a folder, and attic, a second binary, catalogues drives on Windows."
    >
      <div
        ref={scope}
        className="mono text-code grid items-stretch gap-y-3 lg:grid-cols-[minmax(0,7rem)_minmax(3rem,1fr)_minmax(0,18rem)_minmax(3rem,1fr)_minmax(0,21rem)]"
      >
        <ul className="grid grid-cols-3 gap-x-6 lg:grid-cols-1">
          {sources.map((s) => (
            <li
              key={s.name}
              className={`flex h-8 items-center lg:justify-end lg:pr-2 ${kindColor[s.kind]}`}
            >
              {s.name}
            </li>
          ))}
        </ul>

        <Down className="lg:hidden" />
        <Wires side="in" colors={sources.map((s) => stroke[s.kind])} />

        <div
          data-core
          className="frame border-rule bg-panel glow-box grid content-center gap-3 self-center border p-5"
        >
          <span className="display text-[1.25rem]">{brand.cmd}</span>
          <ul className="text-dim grid gap-1">
            <li>messages and threads</li>
            <li>attachments and text</li>
            <li>library: watches, documents</li>
            <li>contacts</li>
            <li>the drive catalogue</li>
          </ul>
        </div>

        <Down className="lg:hidden" />
        <Wires side="out" colors={outputs.map(() => "var(--color-ink)")} />

        <ul className="grid gap-2 lg:grid-rows-5 lg:gap-0">
          {outputs.map(([name, what]) => (
            <li key={name} className="flex items-center">
              <span className="border-rule bg-panel flex w-full items-baseline justify-between gap-3 border px-3 py-1.5">
                <span className="whitespace-nowrap">
                  <span className="text-faint">{brand.cmd} </span>
                  {name}
                </span>
                <span className="text-faint text-right text-[0.76rem] sm:whitespace-nowrap">
                  {what}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <Cells>
        <Cell
          title="Import twice, store once"
          text="A record is keyed by its source and the ID the source gives it, or one derived from its content when there is none. Importing an export again skips the records it already has, and can fill in attachments an earlier import missed."
        >
          <div className="my-auto grid grid-cols-[auto_minmax(1.5rem,1fr)_auto_auto] items-center gap-x-3 gap-y-3 sm:grid-cols-[9rem_minmax(2rem,1fr)_3.4rem_3.4rem]">
            <span className="text-faint col-span-2 text-[0.76rem]">mail.mbox, sample</span>
            <span className="text-faint text-right text-[0.76rem]">new</span>
            <span className="text-faint text-right text-[0.76rem]">known</span>
            {runs.map((run) => (
              <Fragment key={run.when}>
                <span>{run.when}</span>
                <span className="border-rule-soft flex h-[0.85rem] items-center border-l">
                  <span
                    className="bar"
                    style={{
                      width: `${Math.max((run.fresh / runs[0].fresh) * 100, run.fresh ? 3 : 0)}%`,
                    }}
                  />
                </span>
                <span className={`text-right ${run.fresh ? "glow" : "text-faint"}`}>
                  {run.fresh.toLocaleString("en-US")}
                </span>
                <span className="text-faint text-right">{run.known.toLocaleString("en-US")}</span>
              </Fragment>
            ))}
          </div>
        </Cell>
        <Cell
          title="The export is kept"
          text={
            <>
              The file you imported is kept in the archive's data directory. When an importer
              improves,{" "}
              <code className="mono text-ink text-[0.84em]">{brand.cmd} reimport chatgpt</code>{" "}
              replays it, filling in what the earlier import missed without changing refs or stored
              text.
            </>
          }
        >
          <div className="grid flex-1 grid-cols-[auto_minmax(2rem,3.5rem)_minmax(0,1fr)] items-center sm:grid-cols-[auto_minmax(3rem,5.5rem)_minmax(0,1fr)]">
            <Node sub="ChatGPT export">export.zip</Node>
            <span aria-hidden="true" className="glow-line relative my-[1.8rem] self-stretch">
              <span className="border-dim absolute inset-y-0 right-1.5 left-3 border-y border-l" />
              <span className="border-dim absolute top-1/2 left-0 w-3 border-t" />
              <span className="border-l-dim absolute top-0 right-0 -translate-y-1/2 border-y-[3.5px] border-l-[6px] border-y-transparent" />
              <span className="border-l-dim absolute right-0 bottom-0 translate-y-1/2 border-y-[3.5px] border-l-[6px] border-y-transparent" />
            </span>
            <span className="flex flex-col gap-1 self-stretch">
              <Node strong sub="1,940 chats">
                archive
              </Node>
              <Up label="reimport" />
              <Node dashed sub="archive/chatgpt/">
                kept copy
              </Node>
            </span>
          </div>
        </Cell>
      </Cells>
    </Section>
  );
}

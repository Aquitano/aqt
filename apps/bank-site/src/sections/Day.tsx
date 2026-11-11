import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useRef, useState } from "react";

import { brand, kindColor, type Kind } from "../brand";
import { Section } from "../parts";

gsap.registerPlugin(useGSAP, ScrollTrigger);

type Event = { at: string; kind: Kind; ref: string; text: string };

const events: [Event, ...Event[]] = [
  {
    at: "07:52",
    kind: "mail",
    ref: "5b1e09d3c7f2",
    text: "Property office: handover moved to Thursday",
  },
  {
    at: "08:20",
    kind: "library",
    ref: "0d94aa17e6b3",
    text: "Watched: how to read a lease, 14 min",
  },
  {
    at: "09:14",
    kind: "chat",
    ref: "9be2f0416a3d",
    text: "Anna: did you already transfer the deposit?",
  },
  { at: "09:16", kind: "chat", ref: "41c7d2ee90ab", text: "me: doing it now" },
  {
    at: "09:40",
    kind: "disks",
    ref: "attic:7c1e5ab0",
    text: "archive-2:/scans/2024/lease_signed.pdf written",
  },
  {
    at: "09:41",
    kind: "disks",
    ref: "attic:e3380b12",
    text: "archive-2:/scans/2024/deposit_receipt.pdf written",
  },
  { at: "11:02", kind: "mail", ref: "a04d77e19c52", text: "me: Fwd: Signed lease, 1 attachment" },
  { at: "13:30", kind: "ai", ref: "c18f3d9e0a77", text: "Asked: summarise the handover checklist" },
  { at: "13:44", kind: "library", ref: "e77a0c93d1f4", text: "Saved: handover-checklist.md" },
  {
    at: "16:31",
    kind: "mail",
    ref: "3fa91c20b7e4",
    text: "Property office: Re: Deposit and key handover",
  },
  { at: "19:05", kind: "chat", ref: "77f0c1a2d458", text: "Anna: keys on Thursday then" },
  { at: "22:18", kind: "library", ref: "9a6b20fd3c41", text: "Watched: two episodes, 48 min" },
];

const lanes: Kind[] = ["mail", "chat", "ai", "library", "disks"];
const bg = {
  mail: "bg-mail",
  chat: "bg-chat",
  ai: "bg-ai",
  library: "bg-library",
  disks: "bg-disks",
} satisfies Record<Kind, string>;

const left = (at: string) => {
  const [h = "0", m = "0"] = at.split(":");
  return ((Number(h) * 60 + Number(m)) / 1440) * 100;
};

export function Day() {
  const scope = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<Event>(events[4] ?? events[0]);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from("[data-dot]", {
          scale: 0,
          duration: 0.3,
          ease: "back.out(2.5)",
          stagger: { each: 0.06, from: "start" },
          scrollTrigger: { trigger: scope.current, start: "top 75%", once: true },
        });
      });
    },
    { scope },
  );

  return (
    <Section id="day" title="Any day, in the order it happened">
      <div ref={scope} className="mono text-code">
        <p className="border-rule bg-panel border px-4 py-3">
          <span className="text-faint select-none">$ </span>
          {brand.cmd} timeline 2024-02-26
        </p>
        <div className="border-rule border-x border-b px-4 pt-5 pb-3">
          <div className="grid grid-cols-[4.2rem_minmax(0,1fr)] gap-y-1">
            {lanes.map((lane) => (
              <div key={lane} className="contents">
                <span className={`${kindColor[lane]} flex h-9 items-center`}>{lane}</span>
                <div className="border-rule-soft relative h-9 border-b">
                  {events
                    .filter((e) => e.kind === lane)
                    .map((e) => (
                      <button
                        key={e.ref}
                        type="button"
                        data-dot
                        aria-label={`${e.at} ${e.text}`}
                        aria-pressed={e.ref === picked.ref}
                        onMouseEnter={() => setPicked(e)}
                        onFocus={() => setPicked(e)}
                        onClick={() => setPicked(e)}
                        style={{ left: `${left(e.at)}%` }}
                        className={`${bg[lane]} aria-pressed:outline-ink absolute top-1/2 -mt-1.5 -ml-1.5 size-3 cursor-pointer rounded-full outline-offset-4 aria-pressed:outline aria-pressed:outline-1`}
                      />
                    ))}
                </div>
              </div>
            ))}
            <span />
            <div className="text-faint relative h-6">
              {["00", "06", "12", "18", "24"].map((h, i) => (
                <span
                  key={h}
                  className={`absolute top-1.5 ${i === 4 ? "-translate-x-full" : i === 0 ? "" : "-translate-x-1/2"}`}
                  style={{ left: `${i * 25}%` }}
                >
                  {h}
                </span>
              ))}
            </div>
          </div>
        </div>
        <p
          className="border-rule grid gap-x-5 gap-y-1 border-x border-b px-4 py-3 sm:grid-cols-[3rem_9rem_minmax(0,1fr)]"
          aria-live="polite"
        >
          <span className="text-faint">{picked.at}</span>
          <span className="ref">{picked.ref}</span>
          <span>{picked.text}</span>
        </p>
      </div>
    </Section>
  );
}

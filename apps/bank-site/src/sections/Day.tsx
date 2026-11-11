import { useRef, useState } from "react";

import { brand, kindColor, type Kind } from "../brand";
import { gsap, useGSAP, whenMoving } from "../motion";
import { Section } from "../parts";

type Event = { at: string; kind: Kind; ref: string; text: string };

const events: [Event, ...Event[]] = [
  {
    at: "06:10",
    kind: "library",
    ref: "0d94aa17e6b3",
    text: "Watched: how to read a lease, 14 min",
  },
  {
    at: "07:30",
    kind: "mail",
    ref: "5b1e09d3c7f2",
    text: "Property office: handover moved to Thursday",
  },
  {
    at: "08:40",
    kind: "chat",
    ref: "9be2f0416a3d",
    text: "Anna: did you already transfer the deposit?",
  },
  {
    at: "09:50",
    kind: "drives",
    ref: "attic:7c1e5ab0",
    text: "archive-2:/scans/2024/lease_signed.pdf written",
  },
  { at: "10:30", kind: "chat", ref: "41c7d2ee90ab", text: "me: doing it now" },
  { at: "11:20", kind: "mail", ref: "a04d77e19c52", text: "me: Fwd: Signed lease, 1 attachment" },
  {
    at: "12:10",
    kind: "drives",
    ref: "attic:e3380b12",
    text: "archive-2:/scans/2024/deposit_receipt.pdf written",
  },
  { at: "13:30", kind: "ai", ref: "d41b7e02f9a6", text: "Asked: summarise the handover checklist" },
  { at: "14:40", kind: "library", ref: "6f0c2ab94e15", text: "Saved: handover-checklist.md" },
  {
    at: "16:31",
    kind: "mail",
    ref: "3fa91c20b7e4",
    text: "Property office: Re: Deposit and key handover",
  },
  { at: "19:05", kind: "chat", ref: "77f0c1a2d458", text: "Anna: keys on Thursday then" },
  { at: "22:18", kind: "library", ref: "9a6b20fd3c41", text: "Watched: two episodes, 48 min" },
];

const lanes: Kind[] = ["mail", "chat", "ai", "library", "drives"];
const fill = {
  mail: "bg-mail",
  chat: "bg-chat",
  ai: "bg-ai",
  library: "bg-library",
  drives: "bg-drives",
} satisfies Record<Kind, string>;

const minutes = (at: string) => {
  const [h = "0", m = "0"] = at.split(":");
  return Number(h) * 60 + Number(m);
};
const left = (at: string) => `${(minutes(at) / 1440) * 100}%`;

const hours = [
  ["00", "left-0"],
  ["06", "left-1/4 -translate-x-1/2"],
  ["12", "left-1/2 -translate-x-1/2"],
  ["18", "left-3/4 -translate-x-1/2"],
  ["24", "left-full -translate-x-full"],
] as const;

export function Day() {
  const scope = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<Event>(events[5] ?? events[0]);

  useGSAP(
    () => {
      whenMoving(() => {
        const clock = { minute: 0 };
        let shown = -1;
        gsap
          .timeline({ scrollTrigger: { trigger: scope.current, start: "top 70%", once: true } })
          .set("[data-playhead]", { opacity: 1 })
          .to(clock, {
            minute: 1440,
            duration: 4.2,
            ease: "none",
            onUpdate: () => {
              gsap.set("[data-playhead]", { left: `${(clock.minute / 1440) * 100}%` });
              const reached = events.findLastIndex((e) => minutes(e.at) <= clock.minute);
              if (reached === shown) return;
              shown = reached;
              const event = events[reached];
              if (!event) return;
              setPicked(event);
            },
          })
          .to("[data-playhead]", { opacity: 0, duration: 0.4 });
      });
    },
    { scope },
  );

  return (
    <Section id="day" title="What happened on a day">
      <div ref={scope} className="frame mono border-rule text-code border">
        <p className="border-rule bg-panel border-b px-4 py-3">
          <span className="text-faint select-none">$ </span>
          {brand.cmd} timeline 2024-02-26
        </p>
        <div className="grid grid-cols-[4.2rem_minmax(0,1fr)] gap-y-1 px-4 pt-5 pb-3">
          <div className="grid gap-y-1">
            {lanes.map((lane) => (
              <span key={lane} className={`${kindColor[lane]} flex h-9 items-center`}>
                {lane}
              </span>
            ))}
          </div>
          <div className="relative grid gap-y-1">
            {hours.map(([hour, at]) => (
              <span
                key={hour}
                aria-hidden="true"
                className={`border-rule-soft absolute inset-y-0 border-l ${at.split(" ")[0]}`}
              />
            ))}
            <span
              data-playhead
              aria-hidden="true"
              className="bg-ink absolute inset-y-0 w-px opacity-0"
            />
            {lanes.map((lane) => (
              <div key={lane} className="relative h-9">
                {events
                  .filter((e) => e.kind === lane)
                  .map((e) => (
                    <button
                      key={e.ref}
                      type="button"
                      data-dot={e.ref}
                      aria-label={`${e.at} ${e.text}`}
                      aria-current={e.ref === picked.ref}
                      onMouseEnter={() => setPicked(e)}
                      onFocus={() => setPicked(e)}
                      onClick={() => setPicked(e)}
                      style={{ left: left(e.at) }}
                      className={`${fill[lane]} aria-[current=true]:outline-ink absolute top-1/2 -mt-1.5 -ml-1.5 size-3 cursor-pointer rounded-full outline-offset-4 before:absolute before:-inset-2.5 aria-[current=true]:outline aria-[current=true]:outline-1`}
                    />
                  ))}
              </div>
            ))}
          </div>
          <div className="text-faint relative col-start-2 h-6">
            {hours.map(([hour, at]) => (
              <span key={hour} className={`absolute top-1.5 ${at}`}>
                {hour}
              </span>
            ))}
          </div>
        </div>
        <p className="border-rule bg-panel grid min-h-[3.1rem] items-center gap-x-5 gap-y-1 border-t px-4 py-3 sm:grid-cols-[3rem_9rem_minmax(0,1fr)]">
          <span className="text-faint">{picked.at}</span>
          <span className="ref">{picked.ref}</span>
          <span className={kindColor[picked.kind]}>{picked.text}</span>
        </p>
      </div>
    </Section>
  );
}

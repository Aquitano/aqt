import { useRef, useState } from "react";

import { brand, kindColor, type Kind } from "../brand";
import { gsap, useGSAP, whenMoving } from "../motion";
import { Ref, Section } from "../parts";
import { record, type RefId } from "../records";

type Event = { at: string; ref: RefId };

const events: [Event, ...Event[]] = [
  { at: "06:10", ref: "0d94aa17e6b3" },
  { at: "07:30", ref: "5b1e09d3c7f2" },
  { at: "08:40", ref: "9be2f0416a3d" },
  { at: "09:50", ref: "attic:7c1e5ab0" },
  { at: "10:30", ref: "41c7d2ee90ab" },
  { at: "11:20", ref: "a04d77e19c52" },
  { at: "12:10", ref: "attic:e3380b12" },
  { at: "13:30", ref: "d41b7e02f9a6" },
  { at: "14:40", ref: "6f0c2ab94e15" },
  { at: "16:31", ref: "3fa91c20b7e4" },
  { at: "19:05", ref: "77f0c1a2d458" },
  { at: "22:18", ref: "9a6b20fd3c41" },
];

const lanes: Kind[] = ["mail", "chat", "ai", "library", "drives"];
const fill = {
  mail: "bg-mail",
  chat: "bg-chat",
  ai: "bg-ai",
  library: "bg-library",
  drives: "bg-drives",
} satisfies Record<Kind, string>;

const dayPart = (at: string) => {
  const [h = "0", m = "0"] = at.split(":");
  return (Number(h) * 60 + Number(m)) / 1440;
};

const hours = [
  ["00", "left-0", ""],
  ["06", "left-1/4", "-translate-x-1/2"],
  ["12", "left-1/2", "-translate-x-1/2"],
  ["18", "left-3/4", "-translate-x-1/2"],
  ["24", "left-full", "-translate-x-full"],
] as const;

const sweep = 4.2;

export function Day() {
  const scope = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<Event>(events[5] ?? events[0]);
  const entry = record(picked.ref);

  useGSAP(
    () => {
      whenMoving(() => {
        const day = gsap
          .timeline({ scrollTrigger: { trigger: scope.current, start: "top 70%", once: true } })
          .set("[data-playhead]", { opacity: 1 })
          .fromTo(
            "[data-playhead]",
            { left: "0%" },
            { left: "100%", duration: sweep, ease: "none" },
            0,
          );
        for (const event of events) {
          const at = dayPart(event.at) * sweep;
          day
            .from(
              `[data-dot="${event.ref}"]`,
              { scale: 0, duration: 0.35, ease: "back.out(3)" },
              at,
            )
            .call(setPicked, [event], at);
        }
        day.to("[data-playhead]", { opacity: 0, duration: 0.4 }, sweep);
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
                className={`border-rule-soft absolute inset-y-0 border-l ${at}`}
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
                  .filter((e) => record(e.ref).kind === lane)
                  .map((e) => (
                    <button
                      key={e.ref}
                      type="button"
                      data-dot={e.ref}
                      aria-label={`${e.at} ${record(e.ref).from}: ${record(e.ref).text}`}
                      aria-current={e.ref === picked.ref}
                      onMouseEnter={() => setPicked(e)}
                      onFocus={() => setPicked(e)}
                      onClick={() => setPicked(e)}
                      style={{ left: `${dayPart(e.at) * 100}%` }}
                      className={`${fill[lane]} aria-[current=true]:outline-ink absolute top-1/2 -mt-1.5 -ml-1.5 size-3 cursor-pointer rounded-full outline-offset-4 before:absolute before:-inset-2.5 aria-[current=true]:outline aria-[current=true]:outline-1`}
                    />
                  ))}
              </div>
            ))}
          </div>
          <div className="text-faint relative col-start-2 h-6">
            {hours.map(([hour, at, shift]) => (
              <span key={hour} className={`absolute top-1.5 ${at} ${shift}`}>
                {hour}
              </span>
            ))}
          </div>
        </div>
        <p className="border-rule bg-panel grid min-h-[3.1rem] items-center gap-x-5 gap-y-1 border-t px-4 py-3 sm:grid-cols-[3rem_9rem_minmax(0,1fr)]">
          <span className="text-faint">{picked.at}</span>
          <span>
            <Ref id={picked.ref} />
          </span>
          <span className={kindColor[entry.kind]}>
            {entry.from}: {entry.text}
          </span>
        </p>
      </div>
    </Section>
  );
}

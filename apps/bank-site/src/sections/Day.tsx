import { useRef, useState } from "react";

import { brand, kindColor, type Kind } from "../brand";
import { gsap, useGSAP, whenMoving } from "../motion";
import { Ref, Section } from "../parts";
import { record, type RefId } from "../records";

type Event = { at: string; ref: RefId };

const events: [Event, ...Event[]] = [
  { at: "06:10", ref: "activity_4c9e21f0…" },
  { at: "07:30", ref: "bank:5b1e09d3c7f2" },
  { at: "08:40", ref: "bank:9be2f0416a3d" },
  { at: "09:50", ref: "attic:7c1e5ab04f2d9e61" },
  { at: "10:30", ref: "bank:41c7d2ee90ab" },
  { at: "11:20", ref: "bank:a04d77e19c52" },
  { at: "12:10", ref: "attic:e3380b12a95c07d4" },
  { at: "13:30", ref: "bank:d41b7e02f9a6" },
  { at: "14:40", ref: "activity_b61d08e3…" },
  { at: "16:31", ref: "bank:3fa91c20b7e4" },
  { at: "19:05", ref: "bank:77f0c1a2d458" },
  { at: "22:18", ref: "activity_e2057ac4…" },
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
  const step = (by: number) =>
    setPicked(events[(events.indexOf(picked) + by + events.length) % events.length] ?? picked);

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
        // The sweep ends on the last event of the day; settle back on the one the page is about.
        day
          .to("[data-playhead]", { opacity: 0, duration: 0.4 }, sweep)
          .call(setPicked, [events[5] ?? events[0]], sweep + 0.4);
      });
    },
    { scope },
  );

  return (
    <Section
      id="day"
      title="One day, across every source."
      sub="Messages by when they were sent, watches by when they happened, files by when they changed."
    >
      <div ref={scope} className="frame mono border-rule bg-panel text-code border">
        <p className="border-rule flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b px-4 py-3 sm:px-6">
          <span>
            <span className="text-faint select-none">$ </span>
            {brand.cmd} timeline 2024-02-26
          </span>
          <span className="text-faint whitespace-nowrap">
            sample data<span className="max-sm:hidden">, select an event</span>
            <span className="sm:hidden">, tap an event</span>
          </span>
        </p>
        <div className="grid grid-cols-[4.2rem_minmax(0,1fr)] gap-y-1 px-4 pt-5 pb-3 sm:px-6">
          <div className="grid gap-y-1">
            {lanes.map((lane) => (
              <span key={lane} className={`${kindColor[lane]} flex h-9 items-center`}>
                {lane}
              </span>
            ))}
          </div>
          <div className="relative grid gap-y-1">
            {hours.map(([hour, at], i) => (
              <span
                key={hour}
                aria-hidden="true"
                className={`border-rule absolute inset-y-0 border-l ${i % 4 ? "border-dashed" : ""} ${at}`}
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
                      className={`${fill[lane]} ${kindColor[lane]} aria-[current=true]:outline-ink absolute top-1/2 -mt-1.5 -ml-1.5 size-3 cursor-pointer rounded-full shadow-[0_0_10px_currentColor] outline-offset-4 before:absolute before:-inset-3.5 aria-[current=true]:outline aria-[current=true]:outline-1 max-sm:before:-inset-1.5`}
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
        <div className="border-rule flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-t px-4 py-3 sm:px-6">
          <p className="grid min-h-[1.6rem] items-center gap-x-5 gap-y-1 sm:grid-cols-[3rem_auto_minmax(0,1fr)]">
            <span className="text-faint">{picked.at}</span>
            <span>
              <Ref bare id={picked.ref} />
            </span>
            <span>
              <span className="text-dim">{entry.from}: </span>
              {entry.text}
            </span>
          </p>
          <span className="flex items-center gap-2 sm:hidden">
            <span className="text-faint mr-2">
              {events.indexOf(picked) + 1} of {events.length}
            </span>
            <button
              type="button"
              onClick={() => step(-1)}
              className="border-rule text-dim cursor-pointer border px-3 py-1.5"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              className="border-rule text-dim cursor-pointer border px-3 py-1.5"
            >
              Next
            </button>
          </span>
        </div>
      </div>
    </Section>
  );
}

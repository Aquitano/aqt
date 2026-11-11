import { useRef, useState } from "react";

import { kindColor } from "./brand";
import { gsap, useGSAP } from "./motion";
import { isRef, record, type RefId } from "./records";

/** A preview of whichever ref the pointer is on. It trails the pointer instead of sticking to it. */
export function RefTip() {
  const card = useRef<HTMLDivElement>(null);
  const [id, setId] = useState<RefId>("a04d77e19c52");
  const [open, setOpen] = useState(false);

  useGSAP(() => {
    const el = card.current;
    if (!el) return undefined;
    const lag = matchMedia("(prefers-reduced-motion: no-preference)").matches ? 0.5 : 0;
    const toX = gsap.quickTo(el, "x", { duration: lag, ease: "power3" });
    const toY = gsap.quickTo(el, "y", { duration: lag, ease: "power3" });
    let showing = false;

    const place = (x: number, y: number) => {
      const px = Math.max(12, Math.min(x + 18, innerWidth - el.offsetWidth - 12));
      const py = y + 24 + el.offsetHeight > innerHeight ? y - el.offsetHeight - 14 : y + 24;
      if (!showing) gsap.set(el, { x: px, y: py });
      showing = true;
      toX(px);
      toY(py);
    };
    const hide = () => {
      showing = false;
      setOpen(false);
    };
    const refUnder = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>("[data-ref]") : null;

    const over = (event: PointerEvent) => {
      const next = refUnder(event.target)?.dataset.ref;
      if (!isRef(next)) return hide();
      setId(next);
      setOpen(true);
      return place(event.clientX, event.clientY);
    };
    const move = (event: PointerEvent) => {
      if (showing) place(event.clientX, event.clientY);
    };
    const focus = (event: FocusEvent) => {
      const target = refUnder(event.target);
      const next = target?.dataset.ref;
      if (!target || !isRef(next)) return;
      const box = target.getBoundingClientRect();
      setId(next);
      setOpen(true);
      place(box.left, box.bottom - 10);
    };

    document.addEventListener("pointerover", over);
    document.addEventListener("pointermove", move);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
    };
  });

  const entry = record(id);

  return (
    <div
      ref={card}
      role="status"
      className={`frame mono border-rule bg-panel text-code pointer-events-none fixed top-0 left-0 z-20 grid w-[17.5rem] gap-1 border p-3 shadow-[0_12px_32px_rgb(0_0_0/0.35)] transition-opacity duration-150 ${open ? "opacity-100" : "opacity-0"}`}
    >
      <span className="flex justify-between gap-4">
        <span className={kindColor[entry.kind]}>{entry.kind}</span>
        <span className="text-faint">{entry.date}</span>
      </span>
      <span className="text-dim">{entry.from}</span>
      <span className="[overflow-wrap:anywhere]">{entry.text}</span>
      {entry.same ? <span className="text-dim mt-1">= {entry.same}</span> : null}
    </div>
  );
}

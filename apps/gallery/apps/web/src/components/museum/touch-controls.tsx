import { useRef, useState } from "react";

import { useMuseumStore } from "./store";

const BASE = 132;
const KNOB = 56;
/** Maximum knob travel from the base center. */
const TRAVEL = (BASE - KNOB) / 2;

/** On-screen movement joystick for touch devices. It writes a normalized
 * vector to the store; the player rig adds it to the keyboard input. Looking
 * and tap-to-inspect are handled on the canvas itself (see PlayerRig) — this
 * element captures only the touches that land on it. */
export function TouchJoystick() {
  const isTouch = useMuseumStore((s) => s.isTouch);
  const locked = useMuseumStore((s) => s.locked);
  const phase = useMuseumStore((s) => s.inspectPhase);
  const setMove = useMuseumStore((s) => s.setMove);
  const baseRef = useRef<HTMLDivElement>(null);
  const activeId = useRef<number | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });

  if (!isTouch || !locked || phase !== "idle") return null;

  const update = (clientX: number, clientY: number) => {
    const el = baseRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let dx = clientX - (r.left + r.width / 2);
    let dy = clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > TRAVEL) {
      dx = (dx / len) * TRAVEL;
      dy = (dy / len) * TRAVEL;
    }
    setKnob({ x: dx, y: dy });
    // dy is positive downward, so pushing up yields a negative y — forward,
    // matching the keyboard's W (input.y −1).
    setMove({ x: dx / TRAVEL, y: dy / TRAVEL });
  };

  const onStart = (e: React.TouchEvent) => {
    if (activeId.current !== null) return;
    const t = e.changedTouches[0];
    if (!t) return;
    activeId.current = t.identifier;
    update(t.clientX, t.clientY);
  };
  const onMove = (e: React.TouchEvent) => {
    if (activeId.current === null) return;
    const t = Array.from(e.changedTouches).find((touch) => touch.identifier === activeId.current);
    if (t) update(t.clientX, t.clientY);
  };
  const onEnd = (e: React.TouchEvent) => {
    if (activeId.current === null) return;
    const ended = Array.from(e.changedTouches).some(
      (touch) => touch.identifier === activeId.current,
    );
    if (!ended) return;
    activeId.current = null;
    setKnob({ x: 0, y: 0 });
    setMove({ x: 0, y: 0 });
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      <div
        ref={baseRef}
        onTouchStart={onStart}
        onTouchMove={onMove}
        onTouchEnd={onEnd}
        onTouchCancel={onEnd}
        className="pointer-events-auto absolute bottom-10 left-8 rounded-full border border-white/15 bg-white/5 backdrop-blur-sm"
        style={{ width: BASE, height: BASE, touchAction: "none" }}
      >
        <div
          className="absolute rounded-full border border-[#cbb87f]/50 bg-[#cbb87f]/25"
          style={{
            width: KNOB,
            height: KNOB,
            left: TRAVEL + knob.x,
            top: TRAVEL + knob.y,
          }}
        />
      </div>
    </div>
  );
}

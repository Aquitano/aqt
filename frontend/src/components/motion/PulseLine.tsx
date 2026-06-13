"use client";

import gsap from "gsap";
import { useEffect, useId, useRef } from "react";

type PulseLineProps = {
  className?: string;
  /** Seconds for one sweep across the trace. Lower reads as more urgent/active. */
  duration?: number;
  /** Seconds to wait between sweeps. */
  repeatDelay?: number;
};

/**
 * EKG trace: a dim baseline with a bright comet segment sweeping across a
 * heartbeat waveform. Decorative; hidden from assistive tech and static when
 * the user prefers reduced motion. Used as the app's loading affordance — a
 * quick sweep (small `duration`) reads as "working", a slow one as ambient.
 */
export function PulseLine({ className, duration = 5.2, repeatDelay = 0.8 }: PulseLineProps) {
  const cometRef = useRef<SVGPathElement>(null);
  const gradientId = useId();

  useEffect(() => {
    const comet = cometRef.current;
    if (!comet) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const tween = gsap.fromTo(
      comet,
      { attr: { "stroke-dashoffset": 1.16 } },
      {
        attr: { "stroke-dashoffset": -1.16 },
        duration,
        ease: "none",
        repeat: -1,
        repeatDelay,
      },
    );

    return () => {
      tween.kill();
    };
  }, [duration, repeatDelay]);

  const waveform =
    "M0 20 H120 l6 -7 6 7 H190 l5 -16 6 26 5 -10 H320 l6 -5 6 5 H460 l5 -14 7 22 5 -8 H640";

  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 640 40"
      fill="none"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0" />
          <stop offset="0.7" stopColor="var(--accent)" stopOpacity="0.9" />
          <stop offset="1" stopColor="var(--accent-hover)" stopOpacity="1" />
        </linearGradient>
      </defs>
      <path d={waveform} stroke="currentColor" strokeOpacity="0.14" strokeWidth="1.5" />
      <path
        ref={cometRef}
        d={waveform}
        pathLength={1}
        stroke={`url(#${gradientId})`}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="0.16 1"
        strokeDashoffset="1.16"
      />
    </svg>
  );
}

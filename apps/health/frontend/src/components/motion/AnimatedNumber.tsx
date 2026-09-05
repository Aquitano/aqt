"use client";

import gsap from "gsap";
import { useEffect, useRef } from "react";

type AnimatedNumberProps = {
  value: string;
  className?: string;
  duration?: number;
};

const NUMERIC_TOKEN = /\d[\d,]*(?:\.\d+)?/g;

/**
 * Renders a formatted value (e.g. "7,532", "72.5 kg") server-side, then counts
 * the numeric tokens up from zero on mount. Non-numeric values render as-is.
 */
export function AnimatedNumber({ value, className, duration = 0.9 }: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!/\d/.test(value)) return;

    const state = { progress: 0 };
    const tween = gsap.to(state, {
      progress: 1,
      duration,
      ease: "power3.out",
      onUpdate() {
        el.textContent = value.replace(NUMERIC_TOKEN, (match) => {
          const target = Number(match.replace(/,/g, ""));
          if (Number.isNaN(target)) return match;
          const decimals = match.includes(".") ? match.split(".")[1].length : 0;
          const current = target * state.progress;
          if (!match.includes(",")) return current.toFixed(decimals);
          return current.toLocaleString("en", {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          });
        });
      },
    });

    return () => {
      tween.kill();
      el.textContent = value;
    };
  }, [value, duration]);

  return (
    <span ref={ref} className={className}>
      {value}
    </span>
  );
}

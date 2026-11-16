import { Easing, interpolate } from "remotion";

/** 0 before `from`, 1 after `to`, eased in between. */
export const ramp = (
  frame: number,
  from: number,
  to: number,
  easing = Easing.bezier(0.2, 0.7, 0.2, 1),
) =>
  interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });

export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export const inOut = Easing.bezier(0.65, 0, 0.35, 1);
export const easeIn = Easing.bezier(0.55, 0, 1, 0.45);

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText, ScrambleTextPlugin);

/** Runs `animate` only for visitors who have not asked for reduced motion. */
export function whenMoving(animate: () => void) {
  gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", animate);
}

/** Lines of `el` rise out of a mask. Re-splits when fonts or width change. */
export function riseLines(el: Element, vars: gsap.TweenVars = {}) {
  SplitText.create(el, {
    type: "lines",
    mask: "lines",
    autoSplit: true,
    // SplitText reverts and replays the returned tween when it re-splits.
    // oxlint-disable-next-line typescript/no-misused-promises
    onSplit: (split) =>
      gsap.from(split.lines, {
        yPercent: 110,
        duration: 0.9,
        stagger: 0.09,
        ease: "power4.out",
        ...vars,
      }),
  });
}

export { gsap, useGSAP };

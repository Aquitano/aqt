import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(useGSAP, ScrollTrigger);

/** Runs `animate` only for visitors who have not asked for reduced motion. */
export function whenMoving(animate: () => void) {
  gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", animate);
}

export { gsap, ScrollTrigger, useGSAP };

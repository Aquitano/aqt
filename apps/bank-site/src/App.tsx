import { useRef } from "react";

import { brand } from "./brand";
import { gsap, useGSAP, whenMoving } from "./motion";
import { Access } from "./sections/Access";
import { Architecture } from "./sections/Architecture";
import { Day } from "./sections/Day";
import { Footer, Run, Status } from "./sections/Ending";
import { Hero } from "./sections/Hero";
import { Intake } from "./sections/Intake";
import { Refs } from "./sections/Refs";

const links = [
  ["Sources", "#sources"],
  ["Refs", "#refs"],
  ["Architecture", "#architecture"],
  ["Status", "#status"],
  ["GitHub", brand.repo],
] as const;

export function App() {
  const progress = useRef<HTMLSpanElement>(null);

  useGSAP(() => {
    gsap.set(progress.current, { scaleX: 0 });
    whenMoving(() => {
      gsap.to(progress.current, {
        scaleX: 1,
        ease: "none",
        scrollTrigger: { start: 0, end: "max", scrub: 0.3 },
      });
    });
  });

  return (
    <div className="relative mx-auto max-w-[70rem] px-5 pb-10 sm:px-8">
      <nav
        aria-label="Main"
        className="mono bg-ground/90 border-rule sticky top-0 z-10 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 border-b py-4 text-[0.82rem] backdrop-blur-sm"
      >
        <a href="#top" className="frame px-2 py-0.5 text-[1.05rem] font-medium tracking-tight">
          {brand.name.toLowerCase()}
        </a>
        <ul className="text-dim flex flex-wrap gap-x-7 gap-y-1">
          {links.map(([label, href]) => (
            <li key={href} className={href.startsWith("#") ? "hidden sm:block" : ""}>
              <a href={href} className="hover:text-ink">
                {label}
              </a>
            </li>
          ))}
        </ul>
        <span
          ref={progress}
          aria-hidden="true"
          className="bg-ink absolute inset-x-0 -bottom-px h-px origin-left"
        />
      </nav>

      <main id="top" className="grid scroll-mt-20 grid-cols-[minmax(0,1fr)] gap-24 md:gap-32">
        <Hero />
        <Intake />
        <Refs />
        <Day />
        <Architecture />
        <Access />
        <Status />
        <Run />
      </main>

      <Footer />
    </div>
  );
}

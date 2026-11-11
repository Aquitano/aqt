import { brand } from "./brand";
import { RefTip } from "./RefTip";
import { Access } from "./sections/Access";
import { Architecture } from "./sections/Architecture";
import { Day } from "./sections/Day";
import { Footer, Run } from "./sections/Ending";
import { Hero } from "./sections/Hero";
import { Intake } from "./sections/Intake";
import { Refs } from "./sections/Refs";

const links = [
  ["Sources", "#sources"],
  ["Refs", "#refs"],
  ["Architecture", "#architecture"],
  ["GitHub", brand.repo],
] as const;

export function App() {
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
      </nav>

      <main id="top" className="grid scroll-mt-20 grid-cols-[minmax(0,1fr)] gap-24 md:gap-32">
        <Hero />
        <Intake />
        <Refs />
        <Day />
        <Architecture />
        <Access />
        <Run />
      </main>

      <Footer />
      <RefTip />
    </div>
  );
}

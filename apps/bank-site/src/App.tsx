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
  ["Timeline", "#day"],
  ["Agents", "#access"],
  ["Architecture", "#architecture"],
  ["Run", "#run"],
  ["GitHub", brand.repo],
] as const;

/** A phone has room for one row: these three, and the page is short enough to scroll for the rest. */
const onPhones = new Set<string>(["Sources", "Agents", "Run"]);

export function App() {
  return (
    <>
      <nav
        aria-label="Main"
        className="mono bg-ground/80 border-rule sticky top-0 z-10 border-b text-[0.82rem] backdrop-blur-md"
      >
        <div className="mx-auto flex max-w-[70rem] items-center justify-between gap-x-6 px-5 py-4 sm:px-8">
          <a
            href="#top"
            className="frame shrink-0 px-2 py-0.5 text-[1.05rem] font-medium tracking-tight"
          >
            {brand.name.toLowerCase()}
          </a>
          <ul className="text-dim flex min-w-0 [scrollbar-width:none] gap-x-4 py-1 whitespace-nowrap sm:gap-x-7 sm:overflow-x-auto sm:max-md:[mask-image:linear-gradient(to_left,transparent,black_2rem)] sm:max-md:pr-6">
            {links.map(([label, href]) => (
              <li key={href} className={onPhones.has(label) ? "" : "max-sm:hidden"}>
                <a href={href} className="hover:text-ink">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <div className="relative mx-auto max-w-[70rem] px-5 pb-10 sm:px-8">
        <main id="top" className="grid scroll-mt-20 grid-cols-[minmax(0,1fr)] gap-24 md:gap-32">
          <Hero />
          <Intake />
          <Refs />
          <Day />
          <Access />
          <Architecture />
          <Run />
        </main>

        <Footer />
        <RefTip />
      </div>
    </>
  );
}

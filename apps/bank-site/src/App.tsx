import { brand } from "./brand";
import { Access } from "./sections/Access";
import { Architecture } from "./sections/Architecture";
import { Day } from "./sections/Day";
import { Run, Status } from "./sections/Ending";
import { Hero } from "./sections/Hero";
import { Intake } from "./sections/Intake";
import { Refs } from "./sections/Refs";

const links = [
  ["Sources", "#sources"],
  ["Architecture", "#architecture"],
  ["Status", "#status"],
  ["GitHub", brand.repo],
] as const;

export function App() {
  return (
    <div className="relative mx-auto max-w-[70rem] px-5 pb-20 sm:px-8">
      <nav
        aria-label="Main"
        className="mono border-rule flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 border-b py-5 text-[0.82rem]"
      >
        <a href="#top" className="text-[1.05rem] font-medium tracking-tight">
          {brand.name.toLowerCase()}
        </a>
        <ul className="text-dim flex flex-wrap gap-x-7 gap-y-1">
          {links.map(([label, href]) => (
            <li key={href}>
              <a href={href} className="hover:text-ink">
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <main id="top" className="grid grid-cols-[minmax(0,1fr)] gap-24 md:gap-32">
        <Hero />
        <Intake />
        <Refs />
        <Day />
        <Architecture />
        <Access />
        <Status />
        <Run />
      </main>
    </div>
  );
}

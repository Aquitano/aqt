import { brand } from "./brand";
import { Architecture } from "./sections/Architecture";
import { Ask } from "./sections/Ask";
import { Hero } from "./sections/Hero";
import { Hosted, Rules, Run, Status } from "./sections/Rest";
import { Sources } from "./sections/Sources";

const links = [
  ["What goes in", "#sources"],
  ["How it is built", "#architecture"],
  ["Where it stands", "#status"],
  ["Source", brand.repo],
] as const;

export function App() {
  return (
    <div className="relative mx-auto max-w-[70rem] px-5 pb-24 sm:px-8">
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

      <main id="top" className="grid grid-cols-[minmax(0,1fr)] gap-24 md:gap-28">
        <Hero />
        <Sources />
        <Ask />
        <Architecture />
        <Rules />
        <Status />
        <Run />
        <Hosted />
      </main>

      <footer className="mono border-rule text-code text-faint mt-24 flex flex-wrap justify-between gap-x-8 gap-y-2 border-t pt-6">
        <span>{brand.name}, the system of record for a second brain</span>
        <a href={brand.docs} className="hover:text-ink">
          Documentation
        </a>
      </footer>
    </div>
  );
}

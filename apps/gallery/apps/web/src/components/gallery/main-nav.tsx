import { Link } from "@tanstack/react-router";

import type { ActiveGalleryTab } from "./types";

const links = [
  { id: "explore", label: "Explore", to: "/explore" },
  { id: "journal", label: "Journal", to: "/journal" },
  { id: "reviews", label: "Reviews", to: "/reviews" },
] as const;

export function MainNav({ active }: { active: ActiveGalleryTab }) {
  return (
    <nav aria-label="Gallery sections" className="flex items-center gap-6">
      {links.map((link) => (
        <Link
          key={link.id}
          aria-current={active === link.id ? "page" : undefined}
          className="text-[15px] font-medium tracking-[-0.01em] text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:text-foreground"
          to={link.to}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

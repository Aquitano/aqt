import { Link } from "@tanstack/react-router";

import type { ExploreView } from "./types";

const views: { id: ExploreView; label: string }[] = [
  { id: "artworks", label: "Artworks" },
  { id: "spaces", label: "Galleries & museums" },
];

export function ExploreSwitch({
  active,
  to = "/explore",
}: {
  active: ExploreView;
  to?: "/explore" | "/dev/wall";
}) {
  return (
    <nav
      aria-label="Explore view"
      className="inline-flex items-center gap-0.5 rounded-full bg-card p-1"
    >
      {views.map((view) => (
        <Link
          key={view.id}
          to={to}
          search={{ view: view.id }}
          aria-current={active === view.id ? "page" : undefined}
          className="inline-flex h-8 items-center rounded-full px-4 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:bg-secondary aria-[current=page]:text-foreground"
        >
          {view.label}
        </Link>
      ))}
    </nav>
  );
}

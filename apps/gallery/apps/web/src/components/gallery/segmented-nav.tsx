import { cn } from "@aqt/gallery-ui/lib/utils";
import { Link } from "@tanstack/react-router";

import type { ActiveGalleryTab } from "./types";

const tabs = [
  { id: "archive", label: "Archive", to: "/dashboard" },
  { id: "galleries", label: "Galleries", to: "/galleries" },
  { id: "museums", label: "Museums", to: "/museums" },
  { id: "reviews", label: "Reviews", to: "/reviews" },
] as const;

export function SegmentedNav({ active }: { active: ActiveGalleryTab }) {
  return (
    <nav
      aria-label="Gallery sections"
      className="inline-flex items-center gap-0.5 border border-border bg-card p-0.5"
    >
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          aria-current={active === tab.id ? "page" : undefined}
          className={cn(
            "inline-flex h-7 items-center justify-center px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:bg-secondary aria-[current=page]:text-secondary-foreground",
          )}
          to={tab.to}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

import { Link } from "@tanstack/react-router";

import type { ActiveGalleryTab } from "./types";

const tabs = [
	{ id: "archive", label: "Archive", to: "/dashboard" },
	{ id: "galleries", label: "Galleries", to: "/galleries" },
	{ id: "reviews", label: "Reviews", to: "/reviews" },
] as const;

export function SegmentedNav({ active }: { active: ActiveGalleryTab }) {
	return (
		<nav aria-label="Gallery sections" className="gallery-nav-pill">
			{tabs.map((tab) => (
				<Link
					key={tab.id}
					aria-current={active === tab.id ? "page" : undefined}
					className={`gallery-nav-item ${active === tab.id ? "gallery-nav-item-active" : ""}`}
					to={tab.to}
				>
					{tab.label}
				</Link>
			))}
		</nav>
	);
}

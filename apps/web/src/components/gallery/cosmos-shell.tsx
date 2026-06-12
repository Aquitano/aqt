import type { ReactNode } from "react";
import { useState } from "react";

import { GalleryHeader } from "./gallery-header";
import type { ActiveGalleryTab } from "./types";

export function CosmosShell({
	active,
	children,
	search,
	onSearch,
}: {
	active: ActiveGalleryTab;
	children: ReactNode;
	search?: string;
	onSearch?: (value: string) => void;
}) {
	const [internalSearch, setInternalSearch] = useState("");
	const currentSearch = search ?? internalSearch;
	const setSearch = onSearch ?? setInternalSearch;

	return (
		<main className="gallery-app-shell">
			<GalleryHeader
				active={active}
				search={currentSearch}
				onSearch={setSearch}
			/>
			<div className="gallery-main">{children}</div>
		</main>
	);
}

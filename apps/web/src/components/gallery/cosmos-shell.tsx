import type { ReactNode } from "react";
import { useState } from "react";

import { GalleryHeader } from "./gallery-header";
import { ImportProvider } from "./import-provider";
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
		<ImportProvider>
			<div className="min-h-svh bg-background text-foreground">
				<GalleryHeader
					active={active}
					search={currentSearch}
					onSearch={setSearch}
				/>
				<div className="px-4 pb-16 sm:px-8">{children}</div>
			</div>
		</ImportProvider>
	);
}

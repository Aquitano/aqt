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
	searchPlaceholder,
}: {
	active: ActiveGalleryTab;
	children: ReactNode;
	search?: string;
	onSearch?: (value: string) => void;
	searchPlaceholder?: string;
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
					searchPlaceholder={searchPlaceholder}
				/>
				<div className="px-5 pb-24 sm:px-8">{children}</div>
			</div>
		</ImportProvider>
	);
}

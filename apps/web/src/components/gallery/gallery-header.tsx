import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ActionCluster } from "./action-cluster";
import { GallerySearch } from "./gallery-search";
import { ImportDialog } from "./import-dialog";
import { SegmentedNav } from "./segmented-nav";
import type { ActiveGalleryTab } from "./types";

export function GalleryHeader({
	active,
	search,
	onSearch,
}: {
	active: ActiveGalleryTab;
	search: string;
	onSearch: (value: string) => void;
}) {
	const [importOpen, setImportOpen] = useState(false);
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	return (
		<header className="gallery-header">
			<div className="gallery-header-left">
				<SegmentedNav active={active} />
			</div>
			<GallerySearch value={search} onChange={onSearch} />
			<ActionCluster onCreate={() => setImportOpen(true)} />
			<ImportDialog
				open={importOpen}
				onClose={() => setImportOpen(false)}
				onUploaded={() => {
					queryClient.invalidateQueries();
					navigate({ to: "/dashboard" });
				}}
			/>
		</header>
	);
}

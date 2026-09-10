import { ActionCluster } from "./action-cluster";
import { GallerySearch } from "./gallery-search";
import { Logo } from "./logo";
import { MainNav } from "./main-nav";
import type { ActiveGalleryTab } from "./types";

export function GalleryHeader({
	active,
	search,
	onSearch,
	searchPlaceholder,
}: {
	active: ActiveGalleryTab;
	search: string;
	onSearch: (value: string) => void;
	searchPlaceholder?: string;
}) {
	return (
		<header className="sticky top-0 z-30 grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-3 bg-background/85 px-5 py-3.5 backdrop-blur-xl sm:px-8 lg:grid-cols-[1fr_minmax(360px,600px)_1fr]">
			<div className="flex items-center gap-6">
				<Logo />
				<MainNav active={active} />
			</div>
			<div className="order-last col-span-2 lg:order-none lg:col-span-1">
				<GallerySearch
					value={search}
					onChange={onSearch}
					placeholder={searchPlaceholder}
				/>
			</div>
			<ActionCluster />
		</header>
	);
}

import { ActionCluster } from "./action-cluster";
import { GallerySearch } from "./gallery-search";
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
  return (
    <header className="sticky top-0 z-30 grid grid-cols-[1fr_auto] items-center gap-3 border-border/60 border-b bg-background/90 px-4 py-3.5 backdrop-blur-md sm:px-8 lg:grid-cols-[minmax(220px,1fr)_minmax(320px,460px)_minmax(220px,1fr)]">
      <div className="flex items-center gap-3">
        <SegmentedNav active={active} />
      </div>
      <div className="order-last col-span-2 lg:order-none lg:col-span-1">
        <GallerySearch value={search} onChange={onSearch} />
      </div>
      <ActionCluster />
    </header>
  );
}

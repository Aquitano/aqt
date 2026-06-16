import { ArtworkTile } from "./artwork-tile";
import type { ArtworkCard } from "./types";

export function MasonryWall({
	artworks,
	selectable = false,
	selectedIds,
	onToggleSelect,
}: {
	artworks: ArtworkCard[];
	selectable?: boolean;
	selectedIds?: Set<string>;
	onToggleSelect?: (id: string) => void;
}) {
	if (artworks.length === 0) {
		return (
			<div className="gallery-empty-state">
				<h1>Your archive is waiting.</h1>
				<p>
					Use Create to import images, then shape each artwork into a journal
					entry.
				</p>
			</div>
		);
	}

	return (
		<div className="masonry-wall">
			{artworks.map((artwork, index) => (
				<ArtworkTile
					key={artwork.id}
					artwork={artwork}
					index={index}
					selectable={selectable}
					selected={selectedIds?.has(artwork.id) ?? false}
					onToggleSelect={onToggleSelect}
				/>
			))}
		</div>
	);
}

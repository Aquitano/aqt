import { Link } from "@tanstack/react-router";
import { Layers2 } from "lucide-react";
import type { CSSProperties } from "react";

/** The slice of an exhibition the wall needs; both `exhibitions.mine` rows
 * (via `toSpace`) and lobby rows satisfy it. */
export type SpaceTileData = {
	id: string;
	slug: string;
	name: string;
	tagline: string | null;
	coverImageUrl: string | null;
	isPublished: boolean;
	roomCount: number;
	artworkCount: number;
};

/** A gallery or museum on the explore wall: its cover, the stacked-rooms
 * mark for museums, and a caption with what is inside. */
export function SpaceTile({
	exhibition,
	index = 0,
}: {
	exhibition: SpaceTileData;
	index?: number;
}) {
	const isMuseum = exhibition.roomCount > 1;
	const meta = [
		isMuseum ? `Museum · ${exhibition.roomCount} rooms` : "Gallery",
		`${exhibition.artworkCount} ${exhibition.artworkCount === 1 ? "work" : "works"}`,
		exhibition.isPublished ? null : "Draft",
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<Link
			className="tile"
			to="/exhibit/$slug"
			params={{ slug: exhibition.slug }}
		>
			<div
				className="tile-media"
				style={
					{
						"--tile-ratio": exhibition.coverImageUrl ? "auto" : "1.25",
					} as CSSProperties
				}
			>
				{exhibition.coverImageUrl ? (
					<img
						src={exhibition.coverImageUrl}
						alt=""
						loading={index < 10 ? "eager" : "lazy"}
					/>
				) : (
					<div className="tile-empty">Nothing hung yet</div>
				)}
				{isMuseum ? (
					<span className="tile-corner" aria-hidden="true">
						<Layers2 size={13} strokeWidth={2.25} />
					</span>
				) : null}
				<div className="tile-overlay">
					<span>{exhibition.tagline ?? "Open the 2D wall"}</span>
				</div>
			</div>
			<div className="tile-caption">
				<strong>{exhibition.name}</strong>
				<span>{meta}</span>
			</div>
		</Link>
	);
}

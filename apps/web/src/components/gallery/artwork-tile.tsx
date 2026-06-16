import { env } from "@aqt-gallery/env/web";
import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import type { CSSProperties } from "react";

import type { ArtworkCard } from "./types";

export function ArtworkTile({
	artwork,
	index = 0,
	selectable = false,
	selected = false,
	onToggleSelect,
}: {
	artwork: ArtworkCard;
	index?: number;
	selectable?: boolean;
	selected?: boolean;
	onToggleSelect?: (id: string) => void;
}) {
	const imageUrl = artwork.thumbnailUrl
		? `${env.VITE_SERVER_URL}${artwork.thumbnailUrl}`
		: null;
	const ratio =
		artwork.width && artwork.height
			? artwork.width / artwork.height
			: 0.78 + (index % 4) * 0.12;
	const style = { "--tile-ratio": String(ratio) } as CSSProperties;

	const media = imageUrl ? (
		<img
			src={imageUrl}
			alt={[artwork.title, artwork.artist].filter(Boolean).join(" by ")}
		/>
	) : (
		<div className="artwork-tile-empty">{artwork.title}</div>
	);

	// In selection mode the tile is a toggle button instead of a link, so a
	// curator can sweep a batch without leaving the wall.
	if (selectable) {
		return (
			<button
				type="button"
				className="artwork-tile"
				data-selected={selected || undefined}
				style={style}
				aria-pressed={selected}
				onClick={() => onToggleSelect?.(artwork.id)}
			>
				{media}
				<span
					aria-hidden="true"
					className="artwork-tile-check"
					data-selected={selected || undefined}
				>
					{selected ? <Check size={15} strokeWidth={3} /> : null}
				</span>
				<span className="sr-only">
					{selected ? "Deselect" : "Select"} {artwork.title}
				</span>
			</button>
		);
	}

	return (
		<Link
			className="artwork-tile"
			style={style}
			to="/artworks/$artworkId"
			params={{ artworkId: artwork.id }}
		>
			{media}
			<span className="sr-only">{artwork.title}</span>
		</Link>
	);
}

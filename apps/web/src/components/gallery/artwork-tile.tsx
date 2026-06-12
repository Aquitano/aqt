import { env } from "@aqt-gallery/env/web";
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";

import type { ArtworkCard } from "./types";

export function ArtworkTile({
	artwork,
	index = 0,
}: {
	artwork: ArtworkCard;
	index?: number;
}) {
	const imageUrl = artwork.thumbnailUrl
		? `${env.VITE_SERVER_URL}${artwork.thumbnailUrl}`
		: null;
	const ratio =
		artwork.width && artwork.height
			? artwork.width / artwork.height
			: 0.78 + (index % 4) * 0.12;

	return (
		<Link
			className="artwork-tile"
			style={{ "--tile-ratio": String(ratio) } as CSSProperties}
			to="/artworks/$artworkId"
			params={{ artworkId: artwork.id }}
		>
			{imageUrl ? (
				<img
					src={imageUrl}
					alt={[artwork.title, artwork.artist].filter(Boolean).join(" by ")}
				/>
			) : (
				<div className="artwork-tile-empty">{artwork.title}</div>
			)}
			<span className="sr-only">{artwork.title}</span>
		</Link>
	);
}

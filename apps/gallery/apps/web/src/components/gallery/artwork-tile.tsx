import { env } from "@aqt/gallery-env/web";
import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { type CSSProperties, memo } from "react";

import type { ArtworkCard } from "./types";

function tileStyle(width: number | null, height: number | null, index: number) {
  const ratio = width && height ? width / height : 0.78 + (index % 4) * 0.12;
  return { "--tile-ratio": String(ratio) } as CSSProperties;
}

// Memoized so toggling one tile's selection (a new `selected` Set each click)
// re-renders only the tile that changed, not the whole wall. Relies on a stable
// onToggleSelect from the caller (see explore's useCallback).
export const ArtworkTile = memo(function ArtworkTile({
  artwork,
  index = 0,
  selectable = false,
  selected = false,
  onToggleSelect,
  demoSrc,
}: {
  artwork: ArtworkCard;
  index?: number;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  /** Absolute image URL for the dev wall harness; bypasses the media server. */
  demoSrc?: string | null;
}) {
  const imageUrl =
    demoSrc ?? (artwork.thumbnailUrl ? `${env.VITE_SERVER_URL}${artwork.thumbnailUrl}` : null);
  const style = tileStyle(artwork.width, artwork.height, index);
  const meta = [artwork.artist, artwork.year].filter(Boolean).join(", ");

  const body = (
    <div className="tile-media" style={style}>
      {imageUrl ? (
        <img src={imageUrl} alt="" loading={index < 10 ? "eager" : "lazy"} />
      ) : (
        <div className="tile-empty">{artwork.title}</div>
      )}
      <div className="tile-overlay">
        <strong>{artwork.title}</strong>
        {meta ? <span>{meta}</span> : null}
      </div>
    </div>
  );

  // In selection mode the tile is a toggle button instead of a link, so a
  // curator can sweep a batch without leaving the wall.
  if (selectable) {
    return (
      <button
        type="button"
        className="tile"
        data-selected={selected || undefined}
        aria-pressed={selected}
        onClick={() => onToggleSelect?.(artwork.id)}
      >
        {body}
        <span aria-hidden="true" className="tile-check" data-selected={selected || undefined}>
          {selected ? <Check size={14} strokeWidth={3} /> : null}
        </span>
        <span className="sr-only">
          {selected ? "Deselect" : "Select"} {artwork.title}
        </span>
      </button>
    );
  }

  // Only own works have an editor page; another curator's published work is
  // a plain figure until it is selected and hung.
  if (!artwork.isOwn) {
    return <div className="tile">{body}</div>;
  }

  return (
    <Link className="tile" to="/artworks/$artworkId" params={{ artworkId: artwork.id }}>
      {body}
    </Link>
  );
});

/** A hung artwork on a public exhibition wall. Opens the 3D walk at that
 * work, so the 2D wall doubles as a map into the room. */
export type ExhibitTileArtwork = {
  id: string;
  title: string;
  artistName: string | null;
  year: string | null;
  imageUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
};

export function ExhibitTile({
  slug,
  artwork,
  index = 0,
  highlighted = false,
}: {
  slug: string;
  artwork: ExhibitTileArtwork;
  index?: number;
  highlighted?: boolean;
}) {
  const style = tileStyle(artwork.imageWidth, artwork.imageHeight, index);
  const meta = [artwork.artistName, artwork.year].filter(Boolean).join(", ");
  return (
    <Link
      className="tile"
      id={`artwork-${artwork.id}`}
      data-selected={highlighted || undefined}
      to="/museum/$slug"
      params={{ slug }}
      search={{ artwork: artwork.id }}
    >
      <div className="tile-media" style={style}>
        {artwork.imageUrl ? (
          <img src={artwork.imageUrl} alt="" loading={index < 6 ? "eager" : "lazy"} />
        ) : (
          <div className="tile-empty">{artwork.title}</div>
        )}
        <div className="tile-overlay">
          <strong>{artwork.title}</strong>
          <span>{meta || "Walk to this work"}</span>
        </div>
      </div>
      <div className="tile-caption">
        <strong>{artwork.title}</strong>
        {meta ? <span>{meta}</span> : null}
      </div>
    </Link>
  );
}

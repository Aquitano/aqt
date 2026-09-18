import { Button } from "@aqt/gallery-ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@aqt/gallery-ui/components/dropdown-menu";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownWideNarrow, ChevronDown, Globe, Shapes, Tag, User } from "lucide-react";
import type { ReactNode } from "react";

import { useTRPC } from "@/utils/trpc";

import { ARTWORK_TYPES, type ArtworkType } from "./types";

export type ArchiveSort = "newest" | "oldest" | "title" | "rating";

/** Mirrors `artworks.list`'s scope: your own archive, or everyone's published works too. */
export type ArchiveScope = "mine" | "all";

/** A tag or artist id, or `"all"` when that filter is off. */
export type ArchiveFilterId = string;

const SORTS: { value: ArchiveSort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "title", label: "Title A–Z" },
  { value: "rating", label: "Top rated" },
];

const TYPES: { value: ArtworkType | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  ...ARTWORK_TYPES,
];

const SCOPES: { value: ArchiveScope; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "mine", label: "Mine" },
];

/**
 * Filter + sort toolbar for the archive views. Mirrors the inputs accepted by
 * `artworks.list` (scope / sort / artworkType / tagId); "all" maps to an unset
 * filter. The scope menu only renders where a caller wires it, and the tag
 * menu only once the user has at least one tag.
 */
export function ArchiveControls({
  lead,
  scope,
  onScope,
  sort,
  onSort,
  artworkType,
  onArtworkType,
  tagId,
  onTagId,
  artistId = "all",
  onArtistId,
  count,
  action,
  showType = true,
  showTag = true,
  showArtist = true,
}: {
  lead?: ReactNode;
  scope?: ArchiveScope;
  onScope?: (value: ArchiveScope) => void;
  sort: ArchiveSort;
  onSort: (value: ArchiveSort) => void;
  artworkType: ArtworkType | "all";
  onArtworkType: (value: ArtworkType | "all") => void;
  tagId: ArchiveFilterId;
  onTagId: (value: ArchiveFilterId) => void;
  artistId?: ArchiveFilterId;
  onArtistId?: (value: ArchiveFilterId) => void;
  count?: number;
  action?: ReactNode;
  showType?: boolean;
  showTag?: boolean;
  showArtist?: boolean;
}) {
  const trpc = useTRPC();
  const tags = useQuery(trpc.tags.list.queryOptions());
  const tagList = tags.data ?? [];
  // Only load artists when the filter is actually rendered.
  const artists = useQuery({
    ...trpc.artists.list.queryOptions(),
    enabled: showArtist && Boolean(onArtistId),
  });
  const artistList = artists.data ?? [];

  const sortLabel = SORTS.find((s) => s.value === sort)?.label ?? "Newest";
  const scopeLabel = SCOPES.find((s) => s.value === scope)?.label ?? "Everyone";
  const typeLabel = TYPES.find((t) => t.value === artworkType)?.label ?? "All";
  const activeTag = tagList.find((t) => t.id === tagId);
  const activeArtist = artistList.find((a) => a.id === artistId);

  return (
    <div className="flex flex-wrap items-center gap-2 py-4">
      {lead ? <div className="mr-2">{lead}</div> : null}
      {scope && onScope ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant={scope === "all" ? "outline" : "secondary"} size="sm" />}
          >
            <Globe />
            {scopeLabel}
            <ChevronDown className="text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40">
            <DropdownMenuRadioGroup
              value={scope}
              onValueChange={(value) => onScope(value as ArchiveScope)}
            >
              {SCOPES.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
          <ArrowDownWideNarrow />
          {sortLabel}
          <ChevronDown className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-40">
          <DropdownMenuRadioGroup
            value={sort}
            onValueChange={(value) => onSort(value as ArchiveSort)}
          >
            {SORTS.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {showType ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant={artworkType === "all" ? "outline" : "secondary"} size="sm" />}
          >
            <Shapes />
            {typeLabel}
            <ChevronDown className="text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40">
            <DropdownMenuRadioGroup
              value={artworkType}
              onValueChange={(value) => onArtworkType(value as ArtworkType | "all")}
            >
              {TYPES.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {showArtist && onArtistId && artistList.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant={artistId === "all" ? "outline" : "secondary"} size="sm" />}
          >
            <User />
            {activeArtist ? activeArtist.name : "All artists"}
            <ChevronDown className="text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 min-w-44">
            <DropdownMenuRadioGroup value={artistId} onValueChange={(value) => onArtistId(value)}>
              <DropdownMenuRadioItem value="all">All artists</DropdownMenuRadioItem>
              {artistList.map((artist) => (
                <DropdownMenuRadioItem key={artist.id} value={artist.id}>
                  {artist.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {showTag && tagList.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant={tagId === "all" ? "outline" : "secondary"} size="sm" />}
          >
            <Tag />
            {activeTag ? activeTag.name : "All tags"}
            <ChevronDown className="text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 min-w-40">
            <DropdownMenuRadioGroup value={tagId} onValueChange={(value) => onTagId(value)}>
              <DropdownMenuRadioItem value="all">All tags</DropdownMenuRadioItem>
              {tagList.map((tag) => (
                <DropdownMenuRadioItem key={tag.id} value={tag.id}>
                  {tag.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <div className="ml-auto flex items-center gap-3">
        {typeof count === "number" ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {count} {count === 1 ? "work" : "works"}
          </span>
        ) : null}
        {action}
      </div>
    </div>
  );
}

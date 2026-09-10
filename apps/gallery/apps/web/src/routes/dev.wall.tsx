import { Button } from "@aqt/gallery-ui/components/button";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { CheckSquare, Eye, Plus } from "lucide-react";
import { useState } from "react";

import { ArchiveControls } from "@/components/gallery/archive-controls";
import {
  ArtworkEditor,
  type ArtworkFormValues,
  type CustomFieldRow,
} from "@/components/gallery/artwork-editor";
import { ArtworkTile } from "@/components/gallery/artwork-tile";
import { CosmosShell } from "@/components/gallery/cosmos-shell";
import { ExhibitWall, type ExhibitWallData } from "@/components/gallery/exhibit-wall";
import { ExploreSwitch } from "@/components/gallery/explore-switch";
import { MasonryWall } from "@/components/gallery/masonry-wall";
import { SpaceTile, type SpaceTileData } from "@/components/gallery/space-tile";
import { type ArtworkCard, type ExploreView, isExploreView } from "@/components/gallery/types";

/** Dev-only wall with placeholder images, so the explore design can be
 * checked without a database or a signed-in session. */
export const Route = createFileRoute("/dev/wall")({
  component: WallHarness,
  validateSearch: (
    search: Record<string, unknown>,
  ): { view?: ExploreView | "exhibit" | "artwork" } =>
    isExploreView(search.view) || search.view === "exhibit" || search.view === "artwork"
      ? { view: search.view }
      : {},
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
});

const RATIOS = [0.7, 1.4, 0.8, 1, 0.66, 1.25, 0.9, 1.6, 0.75, 1.1];
const ARTISTS = ["Botticelli", "Cimabue", "Giotto", "Duccio", "Fra Angelico"];

const CARDS: ArtworkCard[] = Array.from({ length: 24 }, (_, i) => {
  const ratio = RATIOS[i % RATIOS.length] ?? 1;
  const width = 600;
  const height = Math.round(width / ratio);
  return {
    id: `demo-${i}`,
    title: `Study ${i + 1}`,
    artist: ARTISTS[i % ARTISTS.length] ?? null,
    artworkType: "painting",
    year: String(1420 + i * 7),
    rating: null,
    assetId: null,
    width,
    height,
    thumbnailUrl: null,
    originalUrl: `https://picsum.photos/seed/aqt-${i}/${width}/${height}`,
    tags: [],
  };
});

const SPACES: SpaceTileData[] = Array.from({ length: 9 }, (_, i) => ({
  id: `demo-space-${i}`,
  slug: `demo-space-${i}`,
  name: ["Quattrocento", "Night studies", "Florence, 1480", "Blue period"][i % 4] as string,
  tagline: i % 3 === 0 ? "A slow walk through early light" : null,
  coverImageUrl: i === 4 ? null : `https://picsum.photos/seed/space-${i}/700/${i % 2 ? 900 : 520}`,
  isPublished: i % 3 !== 1,
  roomCount: (i % 3) + 1,
  artworkCount: 4 + i,
}));

const EXHIBIT: ExhibitWallData = {
  id: "demo-exhibit",
  slug: "demo-exhibit",
  kind: "exhibition",
  name: "Florence, 1480",
  tagline: "Three rooms of early light, gold ground and the first true blue.",
  description:
    "A walk from the workshop panels of the 1470s to the large altarpieces that followed, hung in the order they were painted.",
  isPublished: false,
  isOwner: true,
  rooms: ["Workshop", "Altarpieces", "Late works"].map((name, r) => ({
    id: `room-${r}`,
    name,
    description: r === 1 ? "The big commissions, at full scale." : null,
    artworks: CARDS.slice(r * 7, r * 7 + 7).map((card) => ({
      id: card.id,
      title: card.title,
      artistName: card.artist,
      year: card.year,
      imageUrl: card.originalUrl,
      imageWidth: card.width,
      imageHeight: card.height,
    })),
  })),
};

const ARTWORK_FORM: ArtworkFormValues = {
  title: "Virgin and Child Enthroned, and Prophets (Santa Trinita Maesta)",
  artist: "Cimabue",
  artistId: "",
  artworkType: "painting",
  year: "c. 1290–1300",
  medium: "Tempera on wood, gold background",
  dimensions: "384 × 223 cm",
  seenAt: "2026-08-14",
  rating: 5,
  review: "",
  thoughts: "",
  description:
    "Cimabue's Santa Trinita Maesta presents the Virgin and Child on a monumental throne, surrounded by angels and Old Testament prophets beneath the seat.",
  story:
    "This room-opening panel shows Florentine painting still grounded in Byzantine splendor, but already testing weight, architecture, and presence.",
  funFacts:
    "The panel originally hung in the Vallombrosian church of Santa Trinita in Florence.\nThe prophets beneath the throne point toward the Incarnation.",
  sourceUrl: "https://www.uffizi.it/en/artworks/santa-trinita-maesta",
  tags: ["Uffizi", "Florence", "Italian painting", "Gold ground"],
};

function ArtworkHarness() {
  const [form, setForm] = useState(ARTWORK_FORM);
  const [customFields, setCustomFields] = useState<CustomFieldRow[]>([
    { id: "cf-1", label: "Inventory no.", value: "1890 n. 8343" },
  ]);
  const [saved, setSaved] = useState(JSON.stringify(ARTWORK_FORM));
  const dirty = JSON.stringify(form) !== saved;
  return (
    <ArtworkEditor
      image={{
        url: "https://picsum.photos/seed/aqt-maesta/1100/1900",
        width: 1100,
        height: 1900,
      }}
      form={form}
      onFormChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
      customFields={customFields}
      onCustomFieldsChange={setCustomFields}
      artists={[]}
      onEditArtist={() => {}}
      dirty={dirty}
      saving={false}
      onSave={() => setSaved(JSON.stringify(form))}
      onDiscard={() => setForm(JSON.parse(saved))}
      onDelete={() => {}}
    />
  );
}

function WallHarness() {
  const view = Route.useSearch().view ?? "artworks";
  const [search, setSearch] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  if (view === "artwork") {
    return (
      <CosmosShell active="explore" search={search} onSearch={setSearch}>
        <ArtworkHarness />
      </CosmosShell>
    );
  }
  if (view === "exhibit") {
    return (
      <CosmosShell active="explore" search={search} onSearch={setSearch}>
        <div className="flex items-center gap-2 py-4">
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            render={<Link to="/dev/wall" search={{ view: "spaces" }} />}
          >
            ← Back to spaces
          </Button>
        </div>
        <ExhibitWall exhibition={EXHIBIT} selectedArtworkId="demo-9" />
      </CosmosShell>
    );
  }
  if (view === "spaces") {
    return (
      <CosmosShell active="explore" search={search} onSearch={setSearch}>
        <div className="flex flex-wrap items-center gap-2 py-4">
          <ExploreSwitch active={view} to="/dev/wall" />
          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-muted-foreground tabular-nums">
              {SPACES.length} spaces
            </span>
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link to="/dev/wall" search={{ view: "exhibit" }} />}
            >
              <Eye />
              Preview exhibit wall
            </Button>
            <Button size="sm">
              <Plus />
              New gallery
            </Button>
          </div>
        </div>
        <MasonryWall>
          {SPACES.map((space, index) => (
            <SpaceTile key={space.slug} exhibition={space} index={index} />
          ))}
        </MasonryWall>
      </CosmosShell>
    );
  }
  return (
    <CosmosShell
      active="explore"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Try 'Botticelli' or 'still life'"
    >
      <ArchiveControls
        lead={<ExploreSwitch active="artworks" to="/dev/wall" />}
        sort="newest"
        onSort={() => {}}
        artworkType="all"
        onArtworkType={() => {}}
        tagId="all"
        onTagId={() => {}}
        count={CARDS.length}
        showTag={false}
        showArtist={false}
        action={
          <>
            <Button
              variant={selectMode ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setSelectMode((v) => !v)}
            >
              <CheckSquare />
              {selectMode ? "Done" : "Select"}
            </Button>
            <Button size="sm">
              <Plus />
              New gallery
            </Button>
          </>
        }
      />
      <MasonryWall>
        {CARDS.map((card, index) => (
          <ArtworkTile
            key={card.id}
            artwork={card}
            index={index}
            selectable={selectMode}
            demoSrc={card.originalUrl}
          />
        ))}
      </MasonryWall>
    </CosmosShell>
  );
}

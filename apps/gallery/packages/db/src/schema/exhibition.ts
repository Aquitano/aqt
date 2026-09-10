import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { artist, artwork } from "./gallery";
import type { Theme } from "./theme";

const timestamps = {
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
};

/** Optional explicit 3D size for a room. Null sizes the room procedurally
 * from its placements. */
export type RoomLayout = {
  width?: number;
  depth?: number;
  height?: number;
};

export type PlacementWall = "north" | "south" | "east" | "west";

/**
 * How an exhibition presents itself. `personal` is a private selection kept
 * in the journal (never published, member notes, 2D view by default); the
 * others are lobby labels for public content.
 */
export const exhibitionKinds = [
  "exhibition",
  "artist_collection",
  "collection",
  "custom",
  "personal",
] as const;
export type ExhibitionKind = (typeof exhibitionKinds)[number];

/**
 * One curated, walkable space: a building of one or more rooms, each hanging
 * an ordered set of artworks. A single-room exhibition is what the UI used to
 * call a gallery, a multi-room one a museum; the renderer, linter and studio
 * treat both as the same thing.
 */
export const exhibition = pgTable(
  "exhibition",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    kind: text("kind").$type<ExhibitionKind>().default("custom").notNull(),
    name: text("name").notNull(),
    tagline: text("tagline"),
    description: text("description"),
    coverImageUrl: text("cover_image_url"),
    /** Member artwork chosen as the cover; null falls back to the first hung
     * artwork. Cleared automatically if the artwork is removed. */
    coverArtworkId: text("cover_artwork_id").references(() => artwork.id, {
      onDelete: "set null",
    }),
    /** Featured artist for artist collections (drives the artist wall). */
    artistId: text("artist_id").references(() => artist.id, {
      onDelete: "set null",
    }),
    /** Clerk user id of the owner; null for system/seeded content. No FK
     * (identities live in Clerk). */
    createdBy: text("created_by"),
    theme: jsonb("theme").$type<Theme>(),
    isPublished: boolean("is_published").default(false).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("exhibition_slug_idx").on(table.slug),
    index("exhibition_created_by_idx").on(table.createdBy),
    index("exhibition_artist_id_idx").on(table.artistId),
    index("exhibition_kind_idx").on(table.kind),
  ],
);

export const room = pgTable(
  "room",
  {
    id: text("id").primaryKey(),
    exhibitionId: text("exhibition_id")
      .notNull()
      .references(() => exhibition.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    layout: jsonb("layout").$type<RoomLayout>(),
    sortOrder: integer("sort_order").default(0).notNull(),
    ...timestamps,
  },
  (table) => [
    index("room_exhibition_id_idx").on(table.exhibitionId),
    uniqueIndex("room_exhibition_slug_idx").on(table.exhibitionId, table.slug),
  ],
);

export const placement = pgTable(
  "placement",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => room.id, { onDelete: "cascade" }),
    artworkId: text("artwork_id")
      .notNull()
      .references(() => artwork.id, { onDelete: "cascade" }),
    position: integer("position").default(0).notNull(),
    wall: text("wall").$type<PlacementWall>(),
    /** Normalized 0..1 offset along the assigned wall, when curated. */
    wallOffset: real("wall_offset"),
    /** Display scale multiplier relative to the artwork's natural size. */
    scale: real("scale"),
    /** Owner's private note on this hang (personal collections). */
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.artworkId] }),
    index("placement_room_id_idx").on(table.roomId),
    index("placement_artwork_id_idx").on(table.artworkId),
  ],
);

export const exhibitionRelations = relations(exhibition, ({ one, many }) => ({
  rooms: many(room),
  artist: one(artist, {
    fields: [exhibition.artistId],
    references: [artist.id],
  }),
}));

export const roomRelations = relations(room, ({ one, many }) => ({
  exhibition: one(exhibition, {
    fields: [room.exhibitionId],
    references: [exhibition.id],
  }),
  placements: many(placement),
}));

export const placementRelations = relations(placement, ({ one }) => ({
  room: one(room, {
    fields: [placement.roomId],
    references: [room.id],
  }),
  artwork: one(artwork, {
    fields: [placement.artworkId],
    references: [artwork.id],
  }),
}));

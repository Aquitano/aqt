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

/** Visual theme for a museum's 3D environment. Canonical shape lives in
 * schema/theme.ts; kept as an alias for back-compat at existing call sites. */
export type MuseumTheme = Theme;

/** Optional explicit 3D layout for a room. When null, the gallery is
 * generated procedurally from placement ordering alone. */
export type RoomLayout = {
	width?: number;
	depth?: number;
	height?: number;
};

export type PlacementWall = "north" | "south" | "east" | "west";

export const museum = pgTable(
	"museum",
	{
		id: text("id").primaryKey(),
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		tagline: text("tagline"),
		description: text("description"),
		coverImageUrl: text("cover_image_url"),
		theme: jsonb("theme").$type<MuseumTheme>(),
		isPublished: boolean("is_published").default(false).notNull(),
		sortOrder: integer("sort_order").default(0).notNull(),
		...timestamps,
	},
	(table) => [uniqueIndex("museum_slug_idx").on(table.slug)],
);

export const room = pgTable(
	"room",
	{
		id: text("id").primaryKey(),
		museumId: text("museum_id")
			.notNull()
			.references(() => museum.id, { onDelete: "cascade" }),
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		layout: jsonb("layout").$type<RoomLayout>(),
		sortOrder: integer("sort_order").default(0).notNull(),
		...timestamps,
	},
	(table) => [
		index("room_museum_id_idx").on(table.museumId),
		uniqueIndex("room_museum_slug_idx").on(table.museumId, table.slug),
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
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.roomId, table.artworkId] }),
		index("placement_room_id_idx").on(table.roomId),
		index("placement_artwork_id_idx").on(table.artworkId),
	],
);

export const groupKinds = [
	"exhibition",
	"artist_collection",
	"collection",
	"custom",
] as const;
export type GroupKind = (typeof groupKinds)[number];

export const artGroup = pgTable(
	"art_group",
	{
		id: text("id").primaryKey(),
		slug: text("slug").notNull(),
		kind: text("kind").$type<GroupKind>().default("collection").notNull(),
		name: text("name").notNull(),
		tagline: text("tagline"),
		description: text("description"),
		coverImageUrl: text("cover_image_url"),
		/** Member artwork chosen as the gallery cover; null falls back to the
		 * first hung artwork. Cleared automatically if the artwork is removed. */
		coverArtworkId: text("cover_artwork_id").references(() => artwork.id, {
			onDelete: "set null",
		}),
		museumId: text("museum_id").references(() => museum.id, {
			onDelete: "set null",
		}),
		artistId: text("artist_id").references(() => artist.id, {
			onDelete: "set null",
		}),
		/** Clerk user id of the owner for user-curated galleries; null for
		 * system/seeded content. No FK (identities live in Clerk). */
		createdBy: text("created_by"),
		theme: jsonb("theme").$type<MuseumTheme>(),
		isPublished: boolean("is_published").default(false).notNull(),
		sortOrder: integer("sort_order").default(0).notNull(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("art_group_slug_idx").on(table.slug),
		index("art_group_museum_id_idx").on(table.museumId),
		index("art_group_artist_id_idx").on(table.artistId),
		index("art_group_created_by_idx").on(table.createdBy),
	],
);

export const groupArtwork = pgTable(
	"group_artwork",
	{
		groupId: text("group_id")
			.notNull()
			.references(() => artGroup.id, { onDelete: "cascade" }),
		artworkId: text("artwork_id")
			.notNull()
			.references(() => artwork.id, { onDelete: "cascade" }),
		position: integer("position").default(0).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.groupId, table.artworkId] }),
		index("group_artwork_group_id_idx").on(table.groupId),
		index("group_artwork_artwork_id_idx").on(table.artworkId),
	],
);

export const artistRelations = relations(artist, ({ many }) => ({
	artworks: many(artwork),
	groups: many(artGroup),
}));

export const museumRelations = relations(museum, ({ many }) => ({
	rooms: many(room),
	groups: many(artGroup),
}));

export const roomRelations = relations(room, ({ one, many }) => ({
	museum: one(museum, {
		fields: [room.museumId],
		references: [museum.id],
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

export const artGroupRelations = relations(artGroup, ({ one, many }) => ({
	museum: one(museum, {
		fields: [artGroup.museumId],
		references: [museum.id],
	}),
	artist: one(artist, {
		fields: [artGroup.artistId],
		references: [artist.id],
	}),
	groupArtworks: many(groupArtwork),
}));

export const groupArtworkRelations = relations(groupArtwork, ({ one }) => ({
	group: one(artGroup, {
		fields: [groupArtwork.groupId],
		references: [artGroup.id],
	}),
	artwork: one(artwork, {
		fields: [groupArtwork.artworkId],
		references: [artwork.id],
	}),
}));

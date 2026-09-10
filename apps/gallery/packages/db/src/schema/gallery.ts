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

const timestamps = {
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => /* @__PURE__ */ new Date())
		.notNull(),
};

export const artist = pgTable(
	"artist",
	{
		id: text("id").primaryKey(),
		// Clerk user id of the owner, or null for seeded/global reference
		// artists that every user can read and link to (but not edit).
		userId: text("user_id"),
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		bio: text("bio"),
		birthYear: integer("birth_year"),
		deathYear: integer("death_year"),
		nationality: text("nationality"),
		portraitUrl: text("portrait_url"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("artist_slug_idx").on(table.slug),
		index("artist_user_id_idx").on(table.userId),
	],
);

export const artwork = pgTable(
	"artwork",
	{
		id: text("id").primaryKey(),
		// Clerk user id of the owner. No FK: identities live in Clerk, not in
		// this database, so cascade-delete no longer applies.
		userId: text("user_id").notNull(),
		title: text("title").notNull(),
		artist: text("artist"),
		artistId: text("artist_id").references(() => artist.id, {
			onDelete: "set null",
		}),
		artworkType: text("artwork_type").default("other").notNull(),
		year: text("year"),
		medium: text("medium"),
		dimensions: text("dimensions"),
		seenAt: timestamp("seen_at"),
		rating: integer("rating"),
		review: text("review"),
		thoughts: text("thoughts"),
		description: text("description"),
		story: text("story"),
		funFacts: jsonb("fun_facts").$type<string[]>(),
		sourceUrl: text("source_url"),
		imageUrl: text("image_url"),
		thumbnailUrl: text("thumbnail_url"),
		/** Aspect ratio metadata for external images (px). */
		imageWidth: integer("image_width"),
		imageHeight: integer("image_height"),
		isPublished: boolean("is_published").default(false).notNull(),
		primaryAssetId: text("primary_asset_id"),
		archivedAt: timestamp("archived_at").defaultNow().notNull(),
		// Soft-delete marker. Distinct from archivedAt (the added-to-collection
		// timestamp the archive sorts by): a non-null deletedAt hides the artwork
		// from the archive and the public render while keeping it restorable
		// until purged.
		deletedAt: timestamp("deleted_at"),
		...timestamps,
	},
	(table) => [
		index("artwork_user_id_idx").on(table.userId),
		index("artwork_primary_asset_id_idx").on(table.primaryAssetId),
		index("artwork_artist_id_idx").on(table.artistId),
		index("artwork_is_published_idx").on(table.isPublished),
		index("artwork_deleted_at_idx").on(table.deletedAt),
	],
);

export const mediaAsset = pgTable(
	"media_asset",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull(),
		artworkId: text("artwork_id")
			.notNull()
			.references(() => artwork.id, { onDelete: "cascade" }),
		originalFilename: text("original_filename").notNull(),
		mimeType: text("mime_type").notNull(),
		byteSize: integer("byte_size").notNull(),
		width: integer("width"),
		height: integer("height"),
		storagePath: text("storage_path").notNull(),
		thumbnailPath: text("thumbnail_path").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("media_asset_user_id_idx").on(table.userId),
		index("media_asset_artwork_id_idx").on(table.artworkId),
	],
);

export const artworkCustomField = pgTable(
	"artwork_custom_field",
	{
		id: text("id").primaryKey(),
		artworkId: text("artwork_id")
			.notNull()
			.references(() => artwork.id, { onDelete: "cascade" }),
		label: text("label").notNull(),
		value: text("value").notNull(),
		position: integer("position").default(0).notNull(),
	},
	(table) => [index("artwork_custom_field_artwork_id_idx").on(table.artworkId)],
);

export const tag = pgTable(
	"tag",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull(),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
	},
	(table) => [
		index("tag_user_id_idx").on(table.userId),
		uniqueIndex("tag_user_slug_idx").on(table.userId, table.slug),
	],
);

export const artworkTag = pgTable(
	"artwork_tag",
	{
		artworkId: text("artwork_id")
			.notNull()
			.references(() => artwork.id, { onDelete: "cascade" }),
		tagId: text("tag_id")
			.notNull()
			.references(() => tag.id, { onDelete: "cascade" }),
	},
	(table) => [
		primaryKey({ columns: [table.artworkId, table.tagId] }),
		index("artwork_tag_artwork_id_idx").on(table.artworkId),
		index("artwork_tag_tag_id_idx").on(table.tagId),
	],
);

/** A real-world art encounter. Visits are separate from artwork metadata: the
 * same work can be saved from more than one exhibition or trip. */
export const visit = pgTable(
	"visit",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull(),
		title: text("title").notNull(),
		venueName: text("venue_name"),
		city: text("city"),
		country: text("country"),
		address: text("address"),
		latitude: real("latitude"),
		longitude: real("longitude"),
		startedAt: timestamp("started_at").defaultNow().notNull(),
		endedAt: timestamp("ended_at"),
		notes: text("notes"),
		isPublic: boolean("is_public").default(false).notNull(),
		...timestamps,
	},
	(table) => [
		index("visit_user_started_idx").on(table.userId, table.startedAt),
		index("visit_user_id_idx").on(table.userId),
	],
);

export const visitArtwork = pgTable(
	"visit_artwork",
	{
		visitId: text("visit_id")
			.notNull()
			.references(() => visit.id, { onDelete: "cascade" }),
		artworkId: text("artwork_id")
			.notNull()
			.references(() => artwork.id, { onDelete: "cascade" }),
		position: integer("position").default(0).notNull(),
		note: text("note"),
	},
	(table) => [
		primaryKey({ columns: [table.visitId, table.artworkId] }),
		index("visit_artwork_artwork_id_idx").on(table.artworkId),
	],
);

export const artworkRelations = relations(artwork, ({ one, many }) => ({
	artistRef: one(artist, {
		fields: [artwork.artistId],
		references: [artist.id],
	}),
	mediaAssets: many(mediaAsset),
	customFields: many(artworkCustomField),
	artworkTags: many(artworkTag),
}));

export const mediaAssetRelations = relations(mediaAsset, ({ one }) => ({
	artwork: one(artwork, {
		fields: [mediaAsset.artworkId],
		references: [artwork.id],
	}),
}));

import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
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
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		bio: text("bio"),
		birthYear: integer("birth_year"),
		deathYear: integer("death_year"),
		nationality: text("nationality"),
		portraitUrl: text("portrait_url"),
		...timestamps,
	},
	(table) => [uniqueIndex("artist_slug_idx").on(table.slug)],
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
		...timestamps,
	},
	(table) => [
		index("artwork_user_id_idx").on(table.userId),
		index("artwork_primary_asset_id_idx").on(table.primaryAssetId),
		index("artwork_artist_id_idx").on(table.artistId),
		index("artwork_is_published_idx").on(table.isPublished),
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

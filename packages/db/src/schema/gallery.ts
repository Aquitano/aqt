import { relations } from 'drizzle-orm';
import { index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { user } from './auth';

const timestamps = {
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
        .defaultNow()
        .$onUpdate(() => /* @__PURE__ */ new Date())
        .notNull(),
};

export const artwork = pgTable(
    'artwork',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => user.id, { onDelete: 'cascade' }),
        title: text('title').notNull(),
        artist: text('artist'),
        artworkType: text('artwork_type').default('other').notNull(),
        year: text('year'),
        seenAt: timestamp('seen_at'),
        rating: integer('rating'),
        review: text('review'),
        thoughts: text('thoughts'),
        description: text('description'),
        sourceUrl: text('source_url'),
        primaryAssetId: text('primary_asset_id'),
        archivedAt: timestamp('archived_at').defaultNow().notNull(),
        ...timestamps,
    },
    (table) => [
        index('artwork_user_id_idx').on(table.userId),
        index('artwork_primary_asset_id_idx').on(table.primaryAssetId),
    ],
);

export const mediaAsset = pgTable(
    'media_asset',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => user.id, { onDelete: 'cascade' }),
        artworkId: text('artwork_id')
            .notNull()
            .references(() => artwork.id, { onDelete: 'cascade' }),
        originalFilename: text('original_filename').notNull(),
        mimeType: text('mime_type').notNull(),
        byteSize: integer('byte_size').notNull(),
        width: integer('width'),
        height: integer('height'),
        storagePath: text('storage_path').notNull(),
        thumbnailPath: text('thumbnail_path').notNull(),
        createdAt: timestamp('created_at').defaultNow().notNull(),
    },
    (table) => [
        index('media_asset_user_id_idx').on(table.userId),
        index('media_asset_artwork_id_idx').on(table.artworkId),
    ],
);

export const gallery = pgTable(
    'gallery',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => user.id, { onDelete: 'cascade' }),
        title: text('title').notNull(),
        description: text('description'),
        coverAssetId: text('cover_asset_id'),
        sortMode: text('sort_mode').default('manual').notNull(),
        ...timestamps,
    },
    (table) => [index('gallery_user_id_idx').on(table.userId)],
);

export const galleryArtwork = pgTable(
    'gallery_artwork',
    {
        galleryId: text('gallery_id')
            .notNull()
            .references(() => gallery.id, { onDelete: 'cascade' }),
        artworkId: text('artwork_id')
            .notNull()
            .references(() => artwork.id, { onDelete: 'cascade' }),
        position: integer('position').default(0).notNull(),
        createdAt: timestamp('created_at').defaultNow().notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.galleryId, table.artworkId] }),
        index('gallery_artwork_gallery_id_idx').on(table.galleryId),
        index('gallery_artwork_artwork_id_idx').on(table.artworkId),
    ],
);

export const artworkCustomField = pgTable(
    'artwork_custom_field',
    {
        id: text('id').primaryKey(),
        artworkId: text('artwork_id')
            .notNull()
            .references(() => artwork.id, { onDelete: 'cascade' }),
        label: text('label').notNull(),
        value: text('value').notNull(),
        position: integer('position').default(0).notNull(),
    },
    (table) => [index('artwork_custom_field_artwork_id_idx').on(table.artworkId)],
);

export const tag = pgTable(
    'tag',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => user.id, { onDelete: 'cascade' }),
        name: text('name').notNull(),
        slug: text('slug').notNull(),
    },
    (table) => [
        index('tag_user_id_idx').on(table.userId),
        uniqueIndex('tag_user_slug_idx').on(table.userId, table.slug),
    ],
);

export const artworkTag = pgTable(
    'artwork_tag',
    {
        artworkId: text('artwork_id')
            .notNull()
            .references(() => artwork.id, { onDelete: 'cascade' }),
        tagId: text('tag_id')
            .notNull()
            .references(() => tag.id, { onDelete: 'cascade' }),
    },
    (table) => [
        primaryKey({ columns: [table.artworkId, table.tagId] }),
        index('artwork_tag_artwork_id_idx').on(table.artworkId),
        index('artwork_tag_tag_id_idx').on(table.tagId),
    ],
);

export const artworkRelations = relations(artwork, ({ many }) => ({
    mediaAssets: many(mediaAsset),
    customFields: many(artworkCustomField),
    galleryArtworks: many(galleryArtwork),
    artworkTags: many(artworkTag),
}));

export const mediaAssetRelations = relations(mediaAsset, ({ one }) => ({
    artwork: one(artwork, {
        fields: [mediaAsset.artworkId],
        references: [artwork.id],
    }),
}));

export const galleryRelations = relations(gallery, ({ many }) => ({
    galleryArtworks: many(galleryArtwork),
}));

export const galleryArtworkRelations = relations(galleryArtwork, ({ one }) => ({
    gallery: one(gallery, {
        fields: [galleryArtwork.galleryId],
        references: [gallery.id],
    }),
    artwork: one(artwork, {
        fields: [galleryArtwork.artworkId],
        references: [artwork.id],
    }),
}));

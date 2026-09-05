import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { Cover, Element } from '@/domain/element'

export const albums = sqliteTable(
  'albums',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    title: text('title').notNull(),
    cover: text('cover', { mode: 'json' }).$type<Cover>().notNull(),
    shareSlug: text('share_slug').unique(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('albums_owner_id_idx').on(t.ownerId)],
)

export const spreads = sqliteTable(
  'spreads',
  {
    id: text('id').primaryKey(),
    albumId: text('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    elements: text('elements', { mode: 'json' }).$type<Element[]>().notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('spreads_album_id_idx').on(t.albumId)],
)

export const photos = sqliteTable(
  'photos',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    key: text('key').notNull(),
    thumbKey: text('thumb_key').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    /** EXIF capture time (unix ms), when the importer could read one. */
    takenAt: integer('taken_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('photos_owner_id_idx').on(t.ownerId)],
)

/**
 * Which photos each spread places, derived from `spreads.elements` on every
 * write. Answers "is this photo in use?" and "is it on a shared album?"
 * without scanning JSON.
 */
export const spreadPhotos = sqliteTable(
  'spread_photos',
  {
    spreadId: text('spread_id')
      .notNull()
      .references(() => spreads.id, { onDelete: 'cascade' }),
    photoId: text('photo_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spreadId, t.photoId] }),
    index('spread_photos_photo_id_idx').on(t.photoId),
  ],
)

/** Bearer tokens for the JSON API. Only a hash is stored; the key is shown once. */
export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    name: text('name').notNull(),
    hash: text('hash').notNull().unique(),
    /** Leading characters of the key, so a list can tell keys apart. */
    prefix: text('prefix').notNull(),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [index('api_keys_owner_id_idx').on(t.ownerId)],
)

export type Album = typeof albums.$inferSelect
export type Spread = typeof spreads.$inferSelect
export type Photo = typeof photos.$inferSelect
export type ApiKey = typeof apiKeys.$inferSelect

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
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
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('photos_owner_id_idx').on(t.ownerId)],
)

export type Album = typeof albums.$inferSelect
export type Spread = typeof spreads.$inferSelect
export type Photo = typeof photos.$inferSelect

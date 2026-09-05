import { type } from 'arktype'
import { coverMaterial, type Cover } from '@/domain/element'
import { COVER_COLORS, type CoverColorName } from '@/book/palette'
import type { Client } from './client'
import { preparePhoto } from './photos'

/** Operations shared by the command line and the MCP server. */

/** The editable shape of a book: what `book put` accepts, minus server fields. */
export function bookDocument(book: {
  album: { title: string; cover: Cover }
  spreads: { id: string; elements: unknown[] }[]
}) {
  return {
    title: book.album.title,
    cover: book.album.cover,
    spreads: book.spreads.map((s) => ({ id: s.id, elements: s.elements })),
  }
}

/** Uploads files one after another so progress reads in order. */
export async function importPhotos(client: Client, files: string[], log: (line: string) => void) {
  const imported = []
  for (const file of files) {
    const prepared = await preparePhoto(file)
    const photo = await client.photos.import(
      { width: prepared.width, height: prepared.height, takenAt: prepared.takenAt },
      prepared.display,
      prepared.thumb,
    )
    log(`${photo.id}  ${file}  ${photo.width}x${photo.height}`)
    imported.push({ ...photo, file })
  }
  return imported
}

/** Resolves a material name and a palette name (or any CSS colour) to a Cover. */
export function coverFrom(input: { material?: string; color?: string }): Cover {
  const material = coverMaterial(input.material ?? 'linen')
  if (material instanceof type.errors) throw new Error(`material ${material.summary}`)
  const color = input.color ?? 'oxblood'
  return { material, color: color in COVER_COLORS ? COVER_COLORS[color as CoverColorName] : color }
}

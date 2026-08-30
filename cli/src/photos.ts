import exifr from 'exifr'
import sharp from 'sharp'

/** Same renditions the browser makes in src/lib/image.ts. */
const DISPLAY_MAX = 2500
const THUMB_MAX = 400
const QUALITY = 86

export type PreparedPhoto = {
  display: Uint8Array
  thumb: Uint8Array
  width: number
  height: number
  takenAt: number | undefined
}

/**
 * Decodes one file, applies its EXIF orientation and encodes the display and
 * thumbnail JPEGs. `width`/`height` describe the display image.
 */
export async function preparePhoto(path: string): Promise<PreparedPhoto> {
  const source = sharp(path).rotate()
  const [display, thumb, exif] = await Promise.all([
    source
      .clone()
      .resize(DISPLAY_MAX, DISPLAY_MAX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: QUALITY })
      .toBuffer({ resolveWithObject: true }),
    source
      .clone()
      .resize(THUMB_MAX, THUMB_MAX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: QUALITY })
      .toBuffer(),
    exifr.parse(path, ['DateTimeOriginal', 'CreateDate']).catch(() => null) as Promise<{
      DateTimeOriginal?: Date
      CreateDate?: Date
    } | null>,
  ])
  const taken = exif?.DateTimeOriginal ?? exif?.CreateDate
  return {
    display: display.data,
    thumb,
    width: display.info.width,
    height: display.info.height,
    takenAt: taken instanceof Date && !Number.isNaN(taken.getTime()) ? taken.getTime() : undefined,
  }
}

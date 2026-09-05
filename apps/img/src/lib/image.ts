const DISPLAY_MAX = 2500;
const THUMB_MAX = 400;
const QUALITY = 0.86;

export type ResizedPhoto = {
  display: Blob;
  thumb: Blob;
  width: number;
  height: number;
};

/**
 * Decodes a picked file and re-encodes it at display and thumbnail sizes.
 * `width`/`height` describe the display image, which is what the editor lays out.
 * HEIC is not decoded in v1: browsers without native support reject the bitmap.
 */
export async function resizePhoto(file: File): Promise<ResizedPhoto> {
  const bitmap = await createImageBitmap(file);
  try {
    const [display, thumb] = await Promise.all([
      encode(bitmap, DISPLAY_MAX),
      encode(bitmap, THUMB_MAX),
    ]);
    return {
      display: display.blob,
      thumb: thumb.blob,
      width: display.width,
      height: display.height,
    };
  } finally {
    bitmap.close();
  }
}

async function encode(bitmap: ImageBitmap, max: number) {
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas is unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: QUALITY,
  });
  return { blob, width, height };
}

export function photoUrl(photoId: string, variant: "display" | "thumb") {
  return variant === "thumb" ? `/api/photos/${photoId}?thumb=1` : `/api/photos/${photoId}`;
}

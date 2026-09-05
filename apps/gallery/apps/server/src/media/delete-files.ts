import { unlink } from "node:fs/promises";

import { publicImageCacheTargets } from "./public-image";

/**
 * Removes the on-disk artefacts a database delete leaves behind. The FK
 * cascades clear the rows; nothing else unlinks the originals, thumbnails, or
 * proxied-image cache, so without this every deleted artwork would keep its
 * pixels on disk forever (unbounded growth, and deleted images persisting
 * past a retention/privacy expectation).
 */

/** Remove a file, treating "already gone" as success. Any other error
 * (permissions, I/O) is logged but never thrown: the DB rows are already
 * deleted, so failing the request would not help the caller — it would just
 * make a successful delete look broken. The log is what surfaces a real
 * storage fault (the very thing that would otherwise reintroduce the leak). */
async function bestEffortUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Failed to remove file ${filePath}:`, error);
    }
  }
}

/** Purge every on-disk artefact tied to a deleted artwork: its stored media
 * asset originals/thumbnails (paths read before the cascade) and any cached
 * proxied images keyed by the artwork id. */
export async function deleteArtworkFiles(opts: {
  uploadRoot: string;
  artworkId: string;
  assetFiles: ReadonlyArray<string>;
}): Promise<void> {
  const targets = [
    ...opts.assetFiles,
    ...publicImageCacheTargets(opts.uploadRoot, "artwork", opts.artworkId),
  ];
  await Promise.all(targets.map(bestEffortUnlink));
}

/** Purge the cached cover image of a deleted museum or gallery. Member
 * artworks survive the delete, so only the entity's own cache is removed. */
export async function deleteEntityCacheFiles(opts: {
  uploadRoot: string;
  entity: "museum" | "group";
  id: string;
}): Promise<void> {
  await Promise.all(
    publicImageCacheTargets(opts.uploadRoot, opts.entity, opts.id).map(bestEffortUnlink),
  );
}

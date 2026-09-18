import { artwork } from "@aqt/gallery-db/schema/gallery";
import { eq, or } from "drizzle-orm";

export const artworkTypes = ["painting", "photo", "sculpture", "print", "object", "other"] as const;
export function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

export function filenameTitle(filename: string) {
  return filename
    .replace(/\.[^/.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The artworks a user may see and hang: their own in any state, plus
 * anyone's published works. The explore wall and the hang mutations share
 * this so whatever the wall lists is guaranteed hangable. */
export function visibleToUser(userId: string) {
  return or(eq(artwork.userId, userId), eq(artwork.isPublished, true));
}

const MEDIA_DIRS = new Set(["originals", "thumbs"]);

/**
 * Turn a stored media path into an object key. New rows store the key already;
 * older rows carry the absolute path of whichever machine wrote them (including
 * Windows separators), so the tail from the media directory onward is what the
 * store is addressed by. Values with no recognisable media directory are
 * returned untouched.
 */
export function mediaKey(stored: string): string {
	const segments = stored.split(/[\\/]+/).filter(Boolean);
	const start = segments.findIndex((s) => MEDIA_DIRS.has(s));
	return start === -1 ? stored : segments.slice(start).join("/");
}

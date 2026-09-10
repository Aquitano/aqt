/** Move `sourceId` to `targetId`'s slot within `ids`, returning a new array.
 * Returns the input order unchanged when either id is absent. */
export function reorder(
	ids: string[],
	sourceId: string,
	targetId: string,
): string[] {
	const next = [...ids];
	const from = next.indexOf(sourceId);
	const to = next.indexOf(targetId);
	if (from === -1 || to === -1) return next;
	next.splice(from, 1);
	next.splice(to, 0, sourceId);
	return next;
}

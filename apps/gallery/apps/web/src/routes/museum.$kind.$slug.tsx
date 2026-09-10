import { createFileRoute, redirect } from "@tanstack/react-router";

/** Pre-exhibition links carried a kind segment; keep them (and their
 * `?artwork=` deep link) working. */
export const Route = createFileRoute("/museum/$kind/$slug")({
	beforeLoad: ({ params, search }) => {
		const artwork = (search as { artwork?: unknown }).artwork;
		throw redirect({
			to: "/museum/$slug",
			params: { slug: params.slug },
			search: typeof artwork === "string" && artwork ? { artwork } : {},
		});
	},
});

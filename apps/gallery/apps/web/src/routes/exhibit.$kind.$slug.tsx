import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/exhibit/$kind/$slug")({
	beforeLoad: ({ params }) => {
		throw redirect({ to: "/exhibit/$slug", params: { slug: params.slug } });
	},
});

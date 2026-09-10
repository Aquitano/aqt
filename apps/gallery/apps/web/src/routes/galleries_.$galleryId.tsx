import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/galleries_/$galleryId")({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/exhibitions/$exhibitionId",
			params: { exhibitionId: params.galleryId },
		});
	},
});

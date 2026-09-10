import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/galleries")({
	beforeLoad: () => {
		throw redirect({ to: "/explore", search: { view: "spaces" } });
	},
});

import { createFileRoute, Link, redirect } from "@tanstack/react-router";

import { getUser } from "@/functions/get-user";

export const Route = createFileRoute("/")({
	beforeLoad: async () => {
		const session = await getUser();
		if (session) {
			throw redirect({ to: "/dashboard" });
		}
		return { session };
	},
	component: HomeComponent,
});

function HomeComponent() {
	return (
		<main className="gallery-login-shell">
			<section className="gallery-login-panel">
				<div className="gallery-logo-button gallery-login-logo">
					<span />
					<span />
					<span />
					<span />
					<span />
					<span />
				</div>
				<h1>AQT Gallery</h1>
				<p>
					Archive images, shape curated gallery pages, and keep a private
					journal for every artwork you have seen.
				</p>
				<Link className="gallery-primary-button" to="/login">
					Enter archive
				</Link>
			</section>
		</main>
	);
}

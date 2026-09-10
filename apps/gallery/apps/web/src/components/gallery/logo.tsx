import { Link } from "@tanstack/react-router";

export function Logo({ size }: { size?: "lg" }) {
	return (
		<Link
			to="/explore"
			aria-label="AQT Gallery"
			className="gallery-logo"
			data-size={size}
		>
			<span />
			<span />
			<span />
			<span />
			<span />
			<span />
		</Link>
	);
}

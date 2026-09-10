import { Button } from "@aqt-gallery/ui/components/button";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/** Full-height, neutral-chrome shell shared by the router's global 404 and
 * error fallbacks. Uses the app design tokens (not the museum's dark theme),
 * since these can surface on any route. */
function CenteredShell({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-svh flex-col items-center justify-center gap-7 bg-background px-6 text-center text-foreground">
			{children}
		</div>
	);
}

export function NotFound() {
	return (
		<CenteredShell>
			<div className="flex flex-col items-center gap-2">
				<p className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.2em]">
					Error 404
				</p>
				<h1 className="font-semibold text-3xl tracking-tight">
					Page not found
				</h1>
				<p className="max-w-sm text-muted-foreground text-sm">
					The page you're looking for doesn't exist, or it may have moved.
				</p>
			</div>
			<div className="flex flex-wrap items-center justify-center gap-2">
				<Button nativeButton={false} render={<Link to="/">Go home</Link>} />
				<Button
					variant="outline"
					nativeButton={false}
					render={<Link to="/museum">Visit the museum</Link>}
				/>
			</div>
		</CenteredShell>
	);
}

export function RouteError({
	error,
	reset,
}: {
	error: Error;
	reset?: () => void;
}) {
	return (
		<CenteredShell>
			<div className="flex flex-col items-center gap-2">
				<p className="font-semibold text-[11px] text-destructive uppercase tracking-[0.2em]">
					Something went wrong
				</p>
				<h1 className="font-semibold text-3xl tracking-tight">
					This page hit an error
				</h1>
				<p className="max-w-md text-muted-foreground text-sm">
					An unexpected error stopped the page from loading. You can try again,
					or head back home.
				</p>
				{error.message ? (
					<pre className="mt-2 max-w-md overflow-x-auto whitespace-pre-wrap border border-border bg-card px-3 py-2 text-left font-mono text-muted-foreground text-xs">
						{error.message}
					</pre>
				) : null}
			</div>
			<div className="flex flex-wrap items-center justify-center gap-2">
				{reset ? <Button onClick={reset}>Try again</Button> : null}
				<Button
					variant="outline"
					nativeButton={false}
					render={<Link to="/">Go home</Link>}
				/>
			</div>
		</CenteredShell>
	);
}

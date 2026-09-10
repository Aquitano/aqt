import { Button } from "@aqt/gallery-ui/components/button";
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
        <p className="text-[11px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
          Error 404
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Page not found</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
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

export function RouteError({ error, reset }: { error: unknown; reset?: () => void }) {
  const message = error instanceof Error ? error.message : "";

  return (
    <CenteredShell>
      <div className="flex flex-col items-center gap-2">
        <p className="text-[11px] font-semibold tracking-[0.2em] text-destructive uppercase">
          Something went wrong
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">This page hit an error</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          An unexpected error stopped the page from loading. You can try again, or head back home.
        </p>
        {message ? (
          <pre className="mt-2 max-w-md overflow-x-auto border border-border bg-card px-3 py-2 text-left font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {message}
          </pre>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {reset ? <Button onClick={reset}>Try again</Button> : null}
        <Button variant="outline" nativeButton={false} render={<Link to="/">Go home</Link>} />
      </div>
    </CenteredShell>
  );
}

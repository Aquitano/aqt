import { Button } from "@aqt/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@aqt/ui/components/card";
import { Progress } from "@aqt/ui/components/progress";
import { ThemeToggle } from "@aqt/ui/components/theme-toggle";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { FlameIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { readToken, writeToken } from "../api";
import { FiltersProvider } from "../filters";
import { int } from "../format";
import { dashboardSessionQuery, healthQuery } from "../queries";
import { TokenTotalProvider } from "../token-total";
import { Pending, RequestFailure } from "./Async";
import { SecretInput } from "./SecretInput";

const navItems = [
  { to: "/", label: "Overview" },
  { to: "/conversations", label: "Conversations" },
  { to: "/bookmarks", label: "Bookmarks" },
  { to: "/analysis", label: "Analysis" },
  { to: "/search", label: "Search" },
  { to: "/machines", label: "Machines" },
  { to: "/settings", label: "Settings" },
] as const;

const column = "mx-auto w-full max-w-310 px-4 sm:px-6";

const useSignedOut = () => {
  const session = useQuery(dashboardSessionQuery());
  return session.data?.mode === "oidc" && session.data.user === null;
};

const Header = () => {
  const session = useQuery(dashboardSessionQuery());
  const signedOut = useSignedOut();
  const queryClient = useQueryClient();
  const [token, setToken] = useState(readToken);

  const apply = () => {
    writeToken(token.trim());
    void queryClient.invalidateQueries();
  };

  return (
    <header className="sticky top-0 z-20 border-b bg-background">
      <div className={`${column} flex h-12 items-center gap-1`}>
        <Link
          to="/"
          className="mr-2 inline-flex shrink-0 items-center gap-2 text-base font-semibold tracking-tight sm:mr-5"
        >
          <FlameIcon className="size-4.5 fill-flame text-flame" />
          <span className="max-sm:hidden">turnstash</span>
        </Link>
        {!signedOut && (
          // The fade on phones shows the navigation continues past the edge.
          <nav className="flex h-full min-w-0 [scrollbar-width:none] gap-0.5 overflow-x-auto max-sm:mask-r-from-[calc(100%-24px)]">
            {navItems.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.to === "/" }}
                className="inline-flex h-full items-center border-b-2 border-transparent px-2.5 whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[status=active]:border-flame data-[status=active]:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        )}
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-1.5">
          {session.data?.mode === "token" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                apply();
              }}
            >
              <SecretInput
                placeholder="Access token"
                aria-label="Access token"
                value={token}
                className="w-28 sm:w-40"
                onChange={(event) => setToken(event.target.value)}
              />
            </form>
          )}
          {session.data?.user && (
            <form action="/auth/logout" method="post" className="flex items-center gap-1.5">
              <span className="max-w-56 truncate text-muted-foreground max-sm:hidden">
                {session.data.user.name}
              </span>
              <Button size="sm" variant="ghost" type="submit">
                Sign out
              </Button>
            </form>
          )}
          {!signedOut && (
            <Button size="icon-sm" variant="ghost" aria-label="Reload data" onClick={apply}>
              <RefreshCwIcon />
            </Button>
          )}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
};

// Totals keep the old prices until the new catalog swaps in, so every query refetches when repricing finishes.
const RepricingNotice = () => {
  const health = useQuery(healthQuery());
  const queryClient = useQueryClient();
  const repricing = health.data?.repricing ?? null;
  const isRepricing = repricing !== null;
  const wasRepricing = useRef(false);
  useEffect(() => {
    if (wasRepricing.current && !isRepricing) void queryClient.invalidateQueries();
    wasRepricing.current = isRepricing;
  }, [isRepricing, queryClient]);
  if (repricing === null) return null;
  return (
    <div role="status" className="relative border-b bg-warning/10">
      <div className={`${column} py-2`}>
        Applying new prices: {int(repricing.done)} of {int(repricing.total)} requests. Totals switch
        over when every request is priced.
      </div>
      <Progress
        aria-label="Repricing progress"
        value={repricing.done}
        max={Math.max(repricing.total, 1)}
        className="absolute inset-x-0 -bottom-px *:data-[slot=progress-track]:h-0.5 *:data-[slot=progress-track]:rounded-none *:data-[slot=progress-track]:bg-transparent"
      />
    </div>
  );
};

const SignIn = () => (
  <main className="grid flex-1 place-items-center px-4 pt-12 pb-24 sm:px-6">
    <Card className="w-full max-w-sm text-center">
      <CardHeader className="justify-items-center">
        <FlameIcon className="mb-1.5 size-8 fill-flame text-flame" />
        <CardTitle className="text-xl">Sign in to Turnstash</CardTitle>
        <CardDescription>
          Your archive of coding-agent sessions and what they cost. Sign in with your authentik
          account to open it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button className="w-full" nativeButton={false} render={<a href="/auth/login" />}>
          Sign in with authentik
        </Button>
      </CardContent>
    </Card>
  </main>
);

const Footer = () => {
  const health = useQuery(healthQuery());
  return (
    <footer className={`${column} mt-auto py-4 text-xs text-muted-foreground`}>
      turnstash{health.data === undefined ? "" : ` ${health.data.version}`}
    </footer>
  );
};

const Dashboard = () => {
  const session = useQuery(dashboardSessionQuery());
  const signedOut = useSignedOut();
  if (session.isPending) return <Pending />;
  if (session.isError)
    return (
      <div className={`${column} py-7`}>
        <RequestFailure error={session.error} />
      </div>
    );
  if (signedOut) return <SignIn />;
  return (
    <>
      <RepricingNotice />
      <Outlet />
    </>
  );
};

export const Layout = () => (
  <TokenTotalProvider>
    <FiltersProvider>
      <div className="flex min-h-screen flex-col">
        <Header />
        <Dashboard />
        <Footer />
      </div>
    </FiltersProvider>
  </TokenTotalProvider>
);

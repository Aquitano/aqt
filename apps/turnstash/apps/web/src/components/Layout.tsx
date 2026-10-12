import { Button, LinkButton, SensitiveInput } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, FlameIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";

import { readToken, writeToken } from "../api";
import { FiltersProvider } from "../filters";
import { int } from "../format";
import { dashboardSessionQuery, healthQuery } from "../queries";
import { ThemeProvider, useTheme } from "../theme";
import { TokenTotalProvider } from "../token-total";
import { Pending, RequestFailure } from "./Async";

const navItems = [
  { to: "/", label: "Overview" },
  { to: "/conversations", label: "Conversations" },
  { to: "/bookmarks", label: "Bookmarks" },
  { to: "/analysis", label: "Analysis" },
  { to: "/search", label: "Search" },
  { to: "/machines", label: "Machines" },
  { to: "/settings", label: "Settings" },
] as const;

const useSignedOut = () => {
  const session = useQuery(dashboardSessionQuery());
  return session.data?.mode === "oidc" && session.data.user === null;
};

const Header = () => {
  const { mode, toggle } = useTheme();
  const session = useQuery(dashboardSessionQuery());
  const signedOut = useSignedOut();
  const queryClient = useQueryClient();
  const [token, setToken] = useState(readToken);

  const apply = () => {
    writeToken(token.trim());
    void queryClient.invalidateQueries();
  };

  return (
    <header className="header">
      <Link to="/" className="brand">
        <FlameIcon size={18} weight="fill" />
        <span>turnstash</span>
      </Link>
      {!signedOut && (
        <nav className="nav">
          {navItems.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === "/" }}
              activeProps={{ className: "is-active" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      )}
      <div className="spacer" />
      <div className="controls">
        {session.data?.mode === "token" && (
          <SensitiveInput
            size="sm"
            placeholder="Access token"
            aria-label="Access token"
            value={token}
            className="token-field"
            onChange={(event: ChangeEvent<HTMLInputElement>) => setToken(event.target.value)}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key === "Enter") apply();
            }}
          />
        )}
        {session.data?.user && (
          <form action="/auth/logout" method="post" className="session">
            <span className="session-name">{session.data.user.name}</span>
            <Button size="sm" variant="ghost" type="submit">
              Sign out
            </Button>
          </form>
        )}
        {!signedOut && (
          <Button
            size="sm"
            shape="square"
            variant="ghost"
            aria-label="Reload data"
            icon={<ArrowsClockwiseIcon />}
            onClick={apply}
          />
        )}
        <Button
          size="sm"
          shape="square"
          variant="ghost"
          aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          icon={mode === "dark" ? <SunIcon /> : <MoonIcon />}
          onClick={toggle}
        />
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
  const share = repricing.total === 0 ? 0 : repricing.done / repricing.total;
  return (
    <div className="notice" role="status">
      <i style={{ width: `${Math.min(100, share * 100)}%` }} />
      <span>
        Applying new prices: {int(repricing.done)} of {int(repricing.total)} requests. Totals switch
        over when every request is priced.
      </span>
    </div>
  );
};

const SignIn = () => (
  <main className="signin">
    <div className="signin-panel">
      <FlameIcon size={32} weight="fill" className="signin-mark" />
      <h1 className="signin-title">Sign in to Turnstash</h1>
      <p className="signin-text">
        Your archive of coding-agent sessions and what they cost. Sign in with your authentik
        account to open it.
      </p>
      <LinkButton href="/auth/login" variant="primary" className="signin-button">
        Sign in with authentik
      </LinkButton>
    </div>
  </main>
);

const Footer = () => {
  const health = useQuery(healthQuery());
  return (
    <footer className="footer">
      turnstash{health.data === undefined ? "" : ` ${health.data.version}`}
    </footer>
  );
};

const Dashboard = () => {
  const session = useQuery(dashboardSessionQuery());
  const signedOut = useSignedOut();
  if (session.isPending) return <Pending />;
  if (session.isError) return <RequestFailure error={session.error} />;
  if (signedOut) return <SignIn />;
  return (
    <>
      <RepricingNotice />
      <Outlet />
    </>
  );
};

export const Layout = () => (
  <ThemeProvider>
    <TokenTotalProvider>
      <FiltersProvider>
        <div className="page">
          <Header />
          <Dashboard />
          <Footer />
        </div>
      </FiltersProvider>
    </TokenTotalProvider>
  </ThemeProvider>
);

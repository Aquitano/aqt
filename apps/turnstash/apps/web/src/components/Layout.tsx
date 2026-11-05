import { Button } from "@aqt/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@aqt/ui/components/card";
import { Progress } from "@aqt/ui/components/progress";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@aqt/ui/components/sidebar";
import { ThemeToggle } from "@aqt/ui/components/theme-toggle";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  BookmarkIcon,
  ChartPieIcon,
  ChevronLeftIcon,
  FlameIcon,
  GaugeIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MessagesSquareIcon,
  MonitorIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { readToken, writeToken } from "../api";
import { FiltersProvider } from "../filters";
import { int } from "../format";
import { dashboardSessionQuery, healthQuery, machinesQuery } from "../queries";
import { TokenTotalProvider } from "../token-total";
import { Pending, RequestFailure } from "./Async";
import { SecretInput } from "./SecretInput";

const navGroups = [
  [
    { to: "/", label: "Overview", Icon: LayoutDashboardIcon },
    { to: "/limits", label: "Limits", Icon: GaugeIcon },
  ],
  [
    { to: "/conversations", label: "Conversations", Icon: MessagesSquareIcon },
    { to: "/bookmarks", label: "Bookmarks", Icon: BookmarkIcon },
    { to: "/search", label: "Search", Icon: SearchIcon },
  ],
  [
    { to: "/analysis", label: "Analysis", Icon: ChartPieIcon },
    { to: "/machines", label: "Machines", Icon: MonitorIcon },
    { to: "/settings", label: "Settings", Icon: SettingsIcon },
  ],
] as const;

const useSignedOut = () => {
  const session = useQuery(dashboardSessionQuery());
  return session.data?.mode === "oidc" && session.data.user === null;
};

const CollapseHandle = () => {
  const { state, toggleSidebar } = useSidebar();
  return (
    <button
      type="button"
      aria-label={state === "expanded" ? "Collapse sidebar" : "Expand sidebar"}
      onClick={toggleSidebar}
      className="absolute top-1/2 -right-3 z-20 flex h-12 w-6 -translate-y-1/2 items-center justify-center rounded-lg bg-card text-muted-foreground ring-1 ring-foreground/8 transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:hidden"
    >
      <ChevronLeftIcon
        className={`size-3.5 transition-transform duration-200 ${state === "collapsed" ? "rotate-180" : ""}`}
      />
    </button>
  );
};

const Navigation = () => {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const machines = useQuery(machinesQuery());
  const health = useQuery(healthQuery());
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <Sidebar collapsible="icon" className="border-r-0!">
      <SidebarHeader className="px-3 pt-3 pb-1">
        <Link
          to="/"
          aria-label="Turnstash overview"
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
          className="flex h-8 items-center gap-2 overflow-hidden rounded-md text-base font-semibold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <FlameIcon className="size-4.5 shrink-0 fill-primary text-primary" />
          <span className="group-data-[collapsible=icon]:hidden">turnstash</span>
        </Link>
      </SidebarHeader>
      <SidebarContent className="gap-0 pt-2">
        {navGroups.map((group) => (
          <SidebarGroup key={group[0].to} className="py-1.5">
            <SidebarGroupContent>
              <SidebarMenu>
                {group.map(({ to, label, Icon }) => (
                  <SidebarMenuItem key={to}>
                    <SidebarMenuButton
                      tooltip={label}
                      isActive={to === "/" ? pathname === "/" : pathname.startsWith(to)}
                      className="h-9 rounded-md text-muted-foreground hover:text-foreground data-active:font-medium data-active:text-foreground"
                      render={
                        <Link
                          to={to}
                          onClick={() => {
                            if (isMobile) setOpenMobile(false);
                          }}
                        />
                      }
                    >
                      <Icon />
                      <span>{label}</span>
                    </SidebarMenuButton>
                    {to === "/machines" && machines.data !== undefined && (
                      <SidebarMenuBadge className="text-muted-foreground">
                        {machines.data.length}
                      </SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="px-4 pb-3 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
        turnstash{health.data === undefined ? "" : ` ${health.data.version}`}
      </SidebarFooter>
      <CollapseHandle />
    </Sidebar>
  );
};

const TopBar = () => {
  const session = useQuery(dashboardSessionQuery());
  const queryClient = useQueryClient();
  const [token, setToken] = useState(readToken);

  const apply = () => {
    writeToken(token.trim());
    void queryClient.invalidateQueries();
  };

  return (
    <header className="sticky top-0 z-20 flex h-12 items-center gap-1.5 bg-background px-4 sm:px-8">
      <SidebarTrigger className="md:hidden" />
      <Link
        to="/"
        className="inline-flex items-center gap-2 text-base font-semibold tracking-tight md:hidden"
      >
        <FlameIcon className="size-4.5 fill-primary text-primary" />
        <span className="max-sm:sr-only">turnstash</span>
      </Link>
      <div className="flex-1" />
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
      <Button size="icon-sm" variant="ghost" aria-label="Reload data" onClick={apply}>
        <RefreshCwIcon />
      </Button>
      <ThemeToggle />
      {session.data?.user && (
        <form action="/auth/logout" method="post" className="flex items-center gap-1.5">
          <Button
            size="icon-sm"
            variant="ghost"
            type="submit"
            aria-label={`Sign out ${session.data.user.name}`}
            title={`Sign out ${session.data.user.name}`}
          >
            <LogOutIcon />
          </Button>
        </form>
      )}
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
    <div role="status" className="relative mx-4 overflow-hidden rounded-lg bg-warning/10 sm:mx-8">
      <div className="px-4 py-2">
        Applying new prices: {int(repricing.done)} of {int(repricing.total)} requests. Totals switch
        over when every request is priced.
      </div>
      <Progress
        aria-label="Repricing progress"
        value={repricing.done}
        max={Math.max(repricing.total, 1)}
        className="absolute inset-x-0 bottom-0 *:data-[slot=progress-track]:h-0.5 *:data-[slot=progress-track]:rounded-none *:data-[slot=progress-track]:bg-transparent"
      />
    </div>
  );
};

const SignIn = () => (
  <main className="grid min-h-screen place-items-center px-4 pt-12 pb-24 sm:px-6">
    <Card className="w-full max-w-sm text-center">
      <CardHeader className="justify-items-center">
        <FlameIcon className="mb-1.5 size-8 fill-primary text-primary" />
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

const Dashboard = () => {
  const session = useQuery(dashboardSessionQuery());
  const signedOut = useSignedOut();
  if (session.isPending) return <Pending />;
  if (session.isError)
    return (
      <div className="px-4 py-7 sm:px-8">
        <RequestFailure error={session.error} />
      </div>
    );
  if (signedOut) return <SignIn />;
  return (
    <SidebarProvider>
      <Navigation />
      <SidebarInset className="min-w-0">
        <TopBar />
        <RepricingNotice />
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
};

export const Layout = () => (
  <TokenTotalProvider>
    <FiltersProvider>
      <div className="flex min-h-screen flex-col">
        <Dashboard />
      </div>
    </FiltersProvider>
  </TokenTotalProvider>
);

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@aqt/ui/components/alert";
import { Button } from "@aqt/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@aqt/ui/components/card";
import { Kbd } from "@aqt/ui/components/kbd";
import { Progress } from "@aqt/ui/components/progress";
import { Separator } from "@aqt/ui/components/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@aqt/ui/components/sidebar";
import { ThemeToggle } from "@aqt/ui/components/theme-toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aqt/ui/components/tooltip";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  BookmarkIcon,
  ChartPieIcon,
  CircleAlertIcon,
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

import { isUnauthorized, readToken, writeToken } from "../api";
import { FiltersProvider } from "../filters";
import { int } from "../format";
import { dashboardSessionQuery, healthQuery, machineRosterQuery } from "../queries";
import { QuotaAlertProvider } from "../quota/context";
import { TokenTotalProvider } from "../token-total";
import { Pending, RequestFailure } from "./Async";
import { QuotaAlerts } from "./QuotaAlerts";
import { SecretInput } from "./SecretInput";

const navGroups = [
  {
    label: "Usage",
    items: [
      { to: "/", label: "Overview", Icon: LayoutDashboardIcon },
      { to: "/limits", label: "Limits", Icon: GaugeIcon },
      { to: "/analysis", label: "Analysis", Icon: ChartPieIcon },
    ],
  },
  {
    label: "Archive",
    items: [
      { to: "/conversations", label: "Conversations", Icon: MessagesSquareIcon },
      { to: "/bookmarks", label: "Bookmarks", Icon: BookmarkIcon },
      { to: "/search", label: "Search", Icon: SearchIcon },
    ],
  },
  {
    label: "Manage",
    items: [
      { to: "/machines", label: "Machines", Icon: MonitorIcon },
      { to: "/settings", label: "Settings", Icon: SettingsIcon },
    ],
  },
] as const;

const useSignedOut = () => {
  const session = useQuery(dashboardSessionQuery());
  return session.data?.mode === "oidc" && session.data.user === null;
};

// Lives in the top bar on every viewport: it collapses the sidebar to icons on desktop and opens
// the drawer on phones. The sidebar also takes Ctrl+B on macOS, so one hint fits every platform.
const SidebarToggle = () => {
  const { state, isMobile, openMobile } = useSidebar();
  const open = isMobile ? openMobile : state === "expanded";
  const label = open ? "Collapse sidebar" : "Expand sidebar";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarTrigger
            aria-label={isMobile ? "Open navigation" : label}
            aria-expanded={open}
            className="text-muted-foreground hover:text-foreground"
          />
        }
      />
      <TooltipContent side="bottom" className="max-md:hidden">
        {label} <Kbd>Ctrl B</Kbd>
      </TooltipContent>
    </Tooltip>
  );
};

const Navigation = () => {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const machines = useQuery(machineRosterQuery());
  const health = useQuery(healthQuery());
  const { isMobile, setOpenMobile } = useSidebar();
  const close = () => {
    if (isMobile) setOpenMobile(false);
  };
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-12 justify-center px-3 py-0 group-data-[collapsible=icon]:px-2">
        <Link
          to="/"
          aria-label="Turnstash overview"
          onClick={close}
          className="flex h-8 items-center gap-2 overflow-hidden rounded-md px-1 text-[15px] font-semibold tracking-tight outline-none group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <FlameIcon className="size-4.5 shrink-0 fill-primary text-primary" />
          <span className="group-data-[collapsible=icon]:hidden">turnstash</span>
        </Link>
      </SidebarHeader>
      <SidebarContent role="navigation" aria-label="Main" className="gap-0">
        {navGroups.map((group) => (
          <SidebarGroup key={group.label} className="py-1">
            <SidebarGroupLabel className="h-7 text-[11px] text-muted-foreground">
              {group.label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {group.items.map(({ to, label, Icon }) => (
                  <SidebarMenuItem key={to}>
                    <SidebarMenuButton
                      tooltip={label}
                      isActive={to === "/" ? pathname === "/" : pathname.startsWith(to)}
                      className="h-9 text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground max-md:h-10 data-active:bg-sidebar-accent data-active:text-foreground data-active:[&_svg]:text-primary"
                      render={
                        <Link to={to} activeOptions={{ exact: to === "/" }} onClick={close} />
                      }
                    >
                      <Icon />
                      <span>{label}</span>
                    </SidebarMenuButton>
                    {to === "/machines" &&
                      machines.data !== undefined &&
                      !(machines.isError && isUnauthorized(machines.error)) && (
                        <SidebarMenuBadge className="top-2! text-muted-foreground max-md:top-2.5!">
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
      <SidebarRail />
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
    <header className="sticky top-0 z-20 flex h-12 items-center gap-1.5 border-b border-border/70 bg-background/85 px-3 backdrop-blur-md sm:px-5">
      <SidebarToggle />
      <Separator orientation="vertical" className="mx-1 my-auto h-4 md:hidden" />
      <Link
        to="/"
        className="inline-flex items-center gap-2 rounded-md text-[15px] font-semibold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:hidden"
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
  if (session.isError && (session.data === undefined || isUnauthorized(session.error)))
    return (
      <div className="px-4 py-7 sm:px-8">
        {session.data?.mode === "oidc" ? (
          <RequestFailure
            error={session.error}
            onRetry={() => void session.refetch()}
            retrying={session.isFetching}
          />
        ) : (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>Could not check your sign-in</AlertTitle>
            <AlertDescription>
              The dashboard is hidden until the server can check your access.
            </AlertDescription>
            <AlertAction>
              <Button
                size="sm"
                variant="outline"
                disabled={session.isFetching}
                onClick={() => void session.refetch()}
              >
                {session.isFetching ? "Retrying…" : "Retry"}
              </Button>
            </AlertAction>
          </Alert>
        )}
      </div>
    );
  if (signedOut) return <SignIn />;
  return (
    <SidebarProvider>
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-background px-4 py-2 text-sm font-medium text-foreground ring-2 ring-ring focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <Navigation />
      <SidebarInset id="main-content" tabIndex={-1} className="min-w-0">
        <TopBar />
        {session.isError && (
          <div className="px-4 sm:px-8">
            <RequestFailure
              error={session.error}
              onRetry={() => void session.refetch()}
              retrying={session.isFetching}
              stale
            />
          </div>
        )}
        <RepricingNotice />
        <QuotaAlerts />
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
};

export const Layout = () => (
  <TokenTotalProvider>
    <QuotaAlertProvider>
      <FiltersProvider>
        <div className="flex min-h-screen flex-col">
          <Dashboard />
        </div>
      </FiltersProvider>
    </QuotaAlertProvider>
  </TokenTotalProvider>
);

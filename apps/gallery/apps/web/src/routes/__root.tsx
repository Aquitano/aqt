import { env } from "@aqt/gallery-env/web";
import type { AppRouter } from "@aqt/gallery-server/api/routers/index";
import { Toaster } from "@aqt/ui/components/sonner";
import { ClerkProvider } from "@clerk/tanstack-react-start";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { TRPCOptionsProxy } from "@trpc/tanstack-react-query";

import appCss from "../index.css?url";
export interface RouterAppContext {
  trpc: TRPCOptionsProxy<AppRouter>;
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "AQT Gallery",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
    scripts: import.meta.env.DEV
      ? [
          {
            src: "https://unpkg.com/react-scan/dist/auto.global.js",
            crossOrigin: "anonymous",
          },
        ]
      : undefined,
  }),

  component: RootDocument,
});

function RootDocument() {
  return (
    <ClerkProvider publishableKey={env.VITE_CLERK_PUBLISHABLE_KEY}>
      <html lang="en" className="dark">
        <head>
          <HeadContent />
        </head>
        <body>
          <Outlet />
          <Toaster richColors />
          <Scripts />
        </body>
      </html>
    </ClerkProvider>
  );
}

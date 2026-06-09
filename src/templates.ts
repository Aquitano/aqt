// ── Generated file map ───────────────────────────────────────────
// Every file the scaffolding writes after create-next-app finishes.
// Keys are paths relative to the project root.

const HONO_INDEX = `import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { healthRoute } from "./routes/health";
import { usersRoute } from "./routes/users";

const app = new Hono()
  .basePath("/api")
  .use("*", logger())
  .use("*", cors())
  .route("/", healthRoute)
  .route("/", usersRoute);

export type AppType = typeof app;
export default app;
`;

const HEALTH_ROUTE = `import { Hono } from "hono";

export const healthRoute = new Hono().get("/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);
`;

const USERS_ROUTE = `import { Hono } from "hono";

// In-memory store – replace with your database
const users = new Map<string, { id: string; name: string; email: string }>();

export const usersRoute = new Hono()
  .get("/users", (c) => c.json({ users: [...users.values()] }))
  .post("/users", async (c) => {
    const body = await c.req.json<{ name: string; email: string }>();
    const id = crypto.randomUUID();
    const user = { id, ...body };
    users.set(id, user);
    return c.json({ user }, 201);
  })
  .get("/users/:id", (c) => {
    const user = users.get(c.req.param("id"));
    if (!user) return c.json({ error: "Not found" }, 404);
    return c.json({ user });
  })
  .delete("/users/:id", (c) => {
    const id = c.req.param("id");
    if (!users.delete(id)) return c.json({ error: "Not found" }, 404);
    return c.json({ deleted: true });
  });
`;

const API_ROUTE = `import app from "@/lib/hono";
import { handle } from "hono/vercel";

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const DELETE = handle(app);
export const PATCH = handle(app);
`;

const LANDING_PAGE = `import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

const techStack = [
  { name: "Next.js 16", desc: "React framework with App Router" },
  { name: "React 19", desc: "With React Compiler enabled" },
  { name: "Tailwind CSS v4", desc: "Utility-first, no PostCSS config needed" },
  { name: "Hono", desc: "Lightweight API routes" },
  { name: "shadcn/ui", desc: "Accessible component primitives" },
  { name: "TypeScript", desc: "End-to-end type safety" },
] as const;

const apiEndpoints = [
  { method: "GET", path: "/api/health", desc: "Health check" },
  { method: "GET", path: "/api/users", desc: "List users" },
  { method: "POST", path: "/api/users", desc: "Create user" },
  { method: "GET", path: "/api/users/:id", desc: "Get user" },
  { method: "DELETE", path: "/api/users/:id", desc: "Delete user" },
] as const;

const methodColors = {
  GET: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  POST: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  DELETE: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
} as const;

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6 md:p-12">
      <div className="w-full max-w-2xl space-y-8">
        <div className="space-y-2 text-center">
          <h1 className="text-4xl font-bold tracking-tight">AQT Stack</h1>
          <p className="text-muted-foreground text-lg">
            Next.js &middot; Hono &middot; Tailwind &middot; shadcn/ui
          </p>
        </div>

        <Separator />

        <Card>
          <CardHeader>
            <CardTitle>Tech Stack</CardTitle>
            <CardDescription>
              Everything wired up and ready to go.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              {techStack.map((t) => (
                <div key={t.name} className="flex items-start gap-3">
                  <div className="bg-primary text-primary-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center rounded text-xs font-medium">
                    {t.name[0]}
                  </div>
                  <div>
                    <p className="text-sm font-medium">{t.name}</p>
                    <p className="text-muted-foreground text-sm">{t.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>API Routes</CardTitle>
            <CardDescription>
              Hono-powered endpoints at{" "}
              <code className="bg-muted rounded px-1.5 py-0.5 text-sm">
                /api/*
              </code>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {apiEndpoints.map((ep) => (
                <div
                  key={\`\${ep.method}-\${ep.path}\`}
                  className="flex items-center gap-3 rounded-md border px-3 py-2"
                >
                  <Badge
                    variant="secondary"
                    className={\`\${methodColors[ep.method]} border-0 font-mono text-xs\`}
                  >
                    {ep.method}
                  </Badge>
                  <code className="text-sm">{ep.path}</code>
                  <span className="text-muted-foreground ml-auto text-sm">
                    {ep.desc}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-center gap-3">
          <a href="/api/health" className={buttonVariants()}>
            Test API
          </a>
          <a
            href="https://nextjs.org/docs"
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: "outline" })}
          >
            Next.js Docs
          </a>
        </div>
      </div>
    </div>
  );
}
`;

export interface TemplateOptions {
  hono: boolean;
}

/**
 * Returns the file templates for a scaffolded project.
 * When `hono` is false, Hono API and route files are excluded.
 */
export function getTemplates(opts: TemplateOptions): Record<string, string> {
  const files: Record<string, string> = {
    'src/app/page.tsx': LANDING_PAGE,
  };

  if (opts.hono) {
    files['src/lib/hono/index.ts'] = HONO_INDEX;
    files['src/lib/hono/routes/health.ts'] = HEALTH_ROUTE;
    files['src/lib/hono/routes/users.ts'] = USERS_ROUTE;
    files['src/app/api/[[...route]]/route.ts'] = API_ROUTE;
  }

  return files;
}

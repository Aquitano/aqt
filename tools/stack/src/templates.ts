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
import { vValidator } from "@hono/valibot-validator";
import * as v from "valibot";

// In-memory store – replace with your database
const users = new Map<string, { id: string; name: string; email: string }>();

const createUserSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1, "Name is required")),
  email: v.pipe(v.string(), v.email("Invalid email")),
});

export const usersRoute = new Hono()
  .get("/users", (c) => c.json({ users: [...users.values()] }))
  .post("/users", vValidator("json", createUserSchema), (c) => {
    const body = c.req.valid("json");
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

const HONO_CLIENT = `import { hc } from "hono/client";
import type { AppType } from "./index";
import { env } from "@/lib/env";

function getBaseUrl(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/**
 * Fully typed Hono RPC client. Paths and response types are inferred from
 * \`AppType\`, so requests are checked end-to-end:
 *
 *   const res = await api.health.$get();
 *   const { status } = await res.json(); // typed
 *
 *   const created = await api.users.$post({
 *     json: { name: "Ada", email: "ada@example.com" },
 *   });
 */
export const client = hc<AppType>(getBaseUrl());
export const api = client.api;
`;

const ENV_FILE = `import { createEnv } from "@t3-oss/env-nextjs";
import * as v from "valibot";

export const env = createEnv({
  server: {
    NODE_ENV: v.optional(
      v.picklist(["development", "test", "production"]),
      "development",
    ),
  },
  client: {
    NEXT_PUBLIC_APP_URL: v.optional(v.pipe(v.string(), v.url())),
  },
  // Destructure manually so Next.js can inline NEXT_PUBLIC_* at build time.
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  },
  emptyStringAsUndefined: true,
});
`;

const ENV_EXAMPLE = `# Server
NODE_ENV=development

# Client
# NEXT_PUBLIC_APP_URL=http://localhost:3000
`;

const THEME_PROVIDER = `"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
`;

const THEME_TOGGLE = `"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

export function ThemeToggle() {
  const { setTheme, resolvedTheme } = useTheme();

  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      className="hover:bg-accent hover:text-accent-foreground inline-flex size-9 items-center justify-center rounded-md border"
    >
      <Sun className="size-4 dark:hidden" />
      <Moon className="hidden size-4 dark:block" />
      <span className="sr-only">Toggle theme</span>
    </button>
  );
}
`;

const VITEST_CONFIG = `import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
`;

const VITEST_SETUP = `import "@testing-library/jest-dom/vitest";
`;

const PAGE_TEST = `import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "./page";

describe("Home", () => {
  it("renders the stack name", () => {
    render(<Home />);
    expect(screen.getByText("AQT Stack")).toBeInTheDocument();
  });
});
`;

const HEALTH_TEST = `import { describe, expect, it } from "vitest";
import app from "@/lib/hono";

describe("health route", () => {
  it("returns ok", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});
`;

// ── Landing page ─────────────────────────────────────────────────

interface LandingOptions {
  hono: boolean;
  shadcn: boolean;
  themes: boolean;
}

const TECH_STACK_ENTRIES = `const techStack = [
  { name: "Next.js 16", desc: "React framework with App Router" },
  { name: "React 19", desc: "With React Compiler enabled" },
  { name: "Tailwind CSS v4", desc: "Utility-first, no PostCSS config needed" },
  { name: "Hono", desc: "Lightweight, type-safe API routes" },
  { name: "Valibot", desc: "Tiny schema validation" },
  { name: "TypeScript", desc: "End-to-end type safety" },
] as const;`;

const API_ENDPOINT_ENTRIES = `const apiEndpoints = [
  { method: "GET", path: "/api/health", desc: "Health check" },
  { method: "GET", path: "/api/users", desc: "List users" },
  { method: "POST", path: "/api/users", desc: "Create user" },
  { method: "GET", path: "/api/users/:id", desc: "Get user" },
  { method: "DELETE", path: "/api/users/:id", desc: "Delete user" },
] as const;`;

function buildRichLanding(opts: LandingOptions): string {
  const themeImport = opts.themes
    ? `import { ThemeToggle } from "@/components/theme-toggle";\n`
    : "";
  const themeSlot = opts.themes
    ? `      <div className="absolute right-4 top-4">\n        <ThemeToggle />\n      </div>\n`
    : "";

  const apiCard = opts.hono
    ? `

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
        </Card>`
    : "";

  const apiButton = opts.hono
    ? `
          <a href="/api/health" className={buttonVariants()}>
            Test API
          </a>`
    : "";

  return `import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
${themeImport}
${TECH_STACK_ENTRIES}

${API_ENDPOINT_ENTRIES}

const methodColors = {
  GET: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  POST: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  DELETE: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
} as const;

export default function Home() {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center p-6 md:p-12">
${themeSlot}      <div className="w-full max-w-2xl space-y-8">
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
        </Card>${apiCard}

        <div className="flex justify-center gap-3">${apiButton}
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
}

function buildPlainLanding(opts: LandingOptions): string {
  const themeImport = opts.themes
    ? `import { ThemeToggle } from "@/components/theme-toggle";\n\n`
    : "";
  const themeSlot = opts.themes
    ? `      <div className="absolute right-4 top-4">\n        <ThemeToggle />\n      </div>\n`
    : "";

  return `${themeImport}${TECH_STACK_ENTRIES}

export default function Home() {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center p-6 md:p-12">
${themeSlot}      <div className="w-full max-w-2xl space-y-8">
        <div className="space-y-2 text-center">
          <h1 className="text-4xl font-bold tracking-tight">AQT Stack</h1>
          <p className="text-muted-foreground text-lg">
            Next.js &middot; Tailwind &middot; TypeScript
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {techStack.map((t) => (
            <div key={t.name} className="rounded-lg border p-4">
              <p className="text-sm font-medium">{t.name}</p>
              <p className="text-muted-foreground text-sm">{t.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
`;
}

function buildLanding(opts: LandingOptions): string {
  return opts.shadcn ? buildRichLanding(opts) : buildPlainLanding(opts);
}

// ── CI workflow ──────────────────────────────────────────────────

function buildCi(opts: TemplateOptions): string {
  const steps = [
    "      - uses: actions/checkout@v4",
    "      - uses: oven-sh/setup-bun@v2",
    "      - run: bun install --frozen-lockfile",
    "      - run: bun run typecheck",
  ];
  if (opts.eslint) steps.push("      - run: bun run lint");
  if (opts.prettier) steps.push("      - run: bun run format:check");
  if (opts.testing) steps.push("      - run: bun run test");
  steps.push("      - run: bun run build");

  return `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
${steps.join("\n")}
`;
}

// ── Template assembly ────────────────────────────────────────────

export interface TemplateOptions {
  hono: boolean;
  shadcn: boolean;
  themes: boolean;
  testing: boolean;
  ci: boolean;
  eslint: boolean;
  prettier: boolean;
}

/** Generated file contents, keyed by path relative to the project root. */
export interface ProjectFiles {
  [path: string]: string;
}

/**
 * Returns the file templates for a scaffolded project, gated by config flags.
 */
export function getTemplates(opts: TemplateOptions): ProjectFiles {
  const files: ProjectFiles = {
    "src/app/page.tsx": buildLanding(opts),
    "src/lib/env.ts": ENV_FILE,
    ".env.example": ENV_EXAMPLE,
  };

  if (opts.hono) {
    files["src/lib/hono/index.ts"] = HONO_INDEX;
    files["src/lib/hono/routes/health.ts"] = HEALTH_ROUTE;
    files["src/lib/hono/routes/users.ts"] = USERS_ROUTE;
    files["src/lib/hono/client.ts"] = HONO_CLIENT;
    files["src/app/api/[[...route]]/route.ts"] = API_ROUTE;
  }

  if (opts.themes) {
    files["src/components/theme-provider.tsx"] = THEME_PROVIDER;
    files["src/components/theme-toggle.tsx"] = THEME_TOGGLE;
  }

  if (opts.testing) {
    files["vitest.config.ts"] = VITEST_CONFIG;
    files["vitest.setup.ts"] = VITEST_SETUP;
    files["src/app/page.test.tsx"] = PAGE_TEST;
    if (opts.hono) {
      files["src/lib/hono/routes/health.test.ts"] = HEALTH_TEST;
    }
  }

  if (opts.ci) {
    files[".github/workflows/ci.yml"] = buildCi(opts);
  }

  return files;
}

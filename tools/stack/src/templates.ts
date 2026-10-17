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
import { sValidator } from "@hono/standard-validator";
import { type } from "arktype";

// In-memory store – replace with your database
const users = new Map<string, { id: string; name: string; email: string }>();

const createUserSchema = type({
  name: "string > 0",
  email: "string.email",
});

export const usersRoute = new Hono()
  .get("/users", (c) => c.json({ users: [...users.values()] }))
  .post("/users", sValidator("json", createUserSchema), (c) => {
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
import { type } from "arktype";

export const env = createEnv({
  server: {
    NODE_ENV: type("'development' | 'test' | 'production' | undefined").pipe((value) => value ?? "development"),
  },
  client: {
    NEXT_PUBLIC_APP_URL: type("string.url | undefined"),
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

const VITEST_CONFIG = `import { defineConfig, lazyPlugins } from "vite-plus";
import react from "@vitejs/plugin-react";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: lazyPlugins(() => [react()]),
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
`;

const VITEST_SETUP = `import "@testing-library/jest-dom/vitest";
`;

const HEALTH_TEST = `import { describe, expect, it } from "vite-plus/test";
import app from "@/lib/hono";

describe("health route", () => {
  it("returns ok", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });
});
`;

const USERS_TEST = `import { describe, expect, it } from "vite-plus/test";
import app from "@/lib/hono";

describe("user validation", () => {
  it("accepts valid input", async () => {
    const response = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada", email: "ada@example.com" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ user: { name: "Ada", email: "ada@example.com" } });
  });

  it.each([
    { name: "", email: "ada@example.com" },
    { name: "Ada", email: "invalid" },
    { name: 42, email: "ada@example.com" },
  ])("rejects invalid input %j", async (input) => {
    const response = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(400);
  });
});
`;

export interface TemplateOptions {
  projectName: string;
  hono: boolean;
  testing: boolean;
}

function buildPageTest(opts: TemplateOptions): string {
  return `import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import Home from "./page";

describe("Home", () => {
  it("renders the app name", () => {
    render(<Home />);
    expect(screen.getByText("${opts.projectName}")).toBeInTheDocument();
  });
});
`;
}

function buildLanding(opts: TemplateOptions): string {
  return `import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@aqt/ui/components/card";
import { ThemeToggle } from "@aqt/ui/components/theme-toggle";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-6">
      <ThemeToggle />
      <Card>
        <CardHeader>
          <CardTitle>${opts.projectName}</CardTitle>
          <CardDescription>Your new app.</CardDescription>
        </CardHeader>
        <CardContent><p>Edit src/app/page.tsx to get started.</p></CardContent>
      </Card>
      ${opts.hono ? "<p>API health: <code>/api/health</code></p>" : ""}
    </main>
  );
}
`;
}

function buildLayout(opts: TemplateOptions): string {
  return `import { ThemeProvider } from "@aqt/ui/components/theme-provider";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "${opts.projectName}",
  description: "Personal app in the aqt workspace",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
`;
}

export function buildCi(opts: TemplateOptions): string {
  return `name: ${opts.projectName}
on:
  push:
    branches: [main]
    paths: &paths
      - "apps/${opts.projectName}/**"
      - "packages/ts/config/**"
      - "packages/ts/ui/**"
      - "tools/oxlint/**"
      - "package.json"
      - "bun.lock"
      - "mise.toml"
      - "vite.config.ts"
      - "tsconfig.json"
      - ".github/workflows/${opts.projectName}.yml"
  pull_request:
    paths: *paths
permissions:
  contents: read
concurrency:
  group: ${opts.projectName}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: jdx/mise-action@v2
        with:
          install_args: bun node
      - run: bun install --frozen-lockfile
      - run: bun run check
        working-directory: apps/${opts.projectName}
      - run: bun run build
        working-directory: apps/${opts.projectName}
`;
}

function buildReadme(opts: TemplateOptions): string {
  return `# ${opts.projectName}

Personal Next.js app in the aqt workspace.

Run from the workspace root:

\`\`\`sh
mise install
bun install
mise run ${opts.projectName}:dev
\`\`\`

Open http://localhost:3000. Optional environment variables are in .env.example.

Run \`mise run ${opts.projectName}:check\` from the root to check this app and shared
TypeScript packages. Root \`mise run ts:check\` and \`mise run check\` include this app.
The task definitions are in \`tools/tasks/${opts.projectName}.toml\`.

From \`apps/${opts.projectName}\`:

- \`bun run check\`: lint, format check, types${opts.testing ? ", and tests" : ""}.
- \`bun run build\`: production build. \`bun run start\`: serve that build.
- \`bun run fmt\`: format with Vite+ and the workspace configuration.
${opts.testing ? "- `bun run test:watch`: run Vitest interactively.\n" : ""}
TypeScript extends \`@aqt/config\`. Validation uses ArkType. React Compiler is enabled.
Components, tokens and fonts come from \`@aqt/ui\` (\`packages/ts/ui\`); its README covers theming, \`--brand\` and adding components. App-specific shadcn blocks go in \`src/components\` with \`bunx --bun shadcn add <block>\` from this directory.

${opts.hono ? "Hono exposes `/api/health` and example `/api/users` routes. The example user store is in memory and has no authentication; replace it before deploying.\n" : ""}
Deployment is not configured. Add app-specific deployment instructions here.
`;
}

const COMPONENTS_JSON =
  JSON.stringify(
    {
      $schema: "https://ui.shadcn.com/schema.json",
      style: "base-maia",
      rsc: true,
      tsx: true,
      tailwind: {
        config: "",
        css: "../../packages/ts/ui/src/styles/globals.css",
        baseColor: "neutral",
        cssVariables: true,
        prefix: "",
      },
      iconLibrary: "lucide",
      aliases: {
        components: "@/components",
        utils: "@aqt/ui/lib/utils",
        ui: "@aqt/ui/components",
        lib: "@/lib",
        hooks: "@/hooks",
      },
      menuColor: "default",
      menuAccent: "subtle",
      registries: {},
    },
    null,
    2,
  ) + "\n";

export interface ProjectFiles {
  [path: string]: string;
}

export function getTemplates(opts: TemplateOptions): ProjectFiles {
  const files: ProjectFiles = {
    "src/app/page.tsx": buildLanding(opts),
    "src/app/layout.tsx": buildLayout(opts),
    "src/app/globals.css": '@import "@aqt/ui/styles/globals.css";\n',
    "src/lib/env.ts": ENV_FILE,
    ".env.example": ENV_EXAMPLE,
    ".gitignore":
      "node_modules/\n.next/\nout/\n.env*\n!.env.example\n*.tsbuildinfo\nnext-env.d.ts\n",
    "README.md": buildReadme(opts),
    "next.config.ts": `import type { NextConfig } from "next";
import "./src/lib/env";

const nextConfig: NextConfig = {
  reactCompiler: true,
  transpilePackages: ["@aqt/ui"],
};
export default nextConfig;
`,
    "tsconfig.json":
      JSON.stringify(
        {
          extends: "@aqt/config/tsconfig.base.json",
          compilerOptions: {
            lib: ["DOM", "DOM.Iterable", "ESNext"],
            allowJs: true,
            jsx: "react-jsx",
            incremental: true,
            plugins: [{ name: "next" }],
            paths: { "@/*": ["./src/*"] },
          },
          include: [
            "next-env.d.ts",
            "**/*.ts",
            "**/*.tsx",
            ".next/types/**/*.ts",
            ".next/dev/types/**/*.ts",
          ],
          exclude: ["node_modules"],
        },
        null,
        2,
      ) + "\n",
    "src/styles.d.ts": 'declare module "*.css";\n',
    "components.json": COMPONENTS_JSON,
  };
  if (opts.hono) {
    files["src/lib/hono/index.ts"] = HONO_INDEX;
    files["src/lib/hono/routes/health.ts"] = HEALTH_ROUTE;
    files["src/lib/hono/routes/users.ts"] = USERS_ROUTE;
    files["src/lib/hono/client.ts"] = HONO_CLIENT;
    files["src/app/api/[[...route]]/route.ts"] = API_ROUTE;
  }
  if (opts.testing) {
    files["vite.config.ts"] = VITEST_CONFIG;
    files["vitest.setup.ts"] = VITEST_SETUP;
    files["src/app/page.test.tsx"] = buildPageTest(opts);
    if (opts.hono) {
      files["src/lib/hono/routes/health.test.ts"] = HEALTH_TEST;
      files["src/lib/hono/routes/users.test.ts"] = USERS_TEST;
    }
  }
  return files;
}

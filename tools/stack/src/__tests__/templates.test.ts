import { describe, expect, test } from "bun:test";
import { getTemplates, type TemplateOptions } from "../templates.ts";

function opts(overrides: Partial<TemplateOptions> = {}): TemplateOptions {
  return {
    hono: true,
    shadcn: true,
    themes: false,
    testing: false,
    ci: false,
    eslint: true,
    prettier: true,
    ...overrides,
  };
}

describe("getTemplates", () => {
  test("always includes landing page, env, and .env.example", () => {
    const files = getTemplates(opts({ hono: false }));
    expect(Object.keys(files)).toContain("src/app/page.tsx");
    expect(Object.keys(files)).toContain("src/lib/env.ts");
    expect(Object.keys(files)).toContain(".env.example");
  });

  test("with hono: true returns all hono files including RPC client", () => {
    const files = getTemplates(opts({ hono: true }));
    const keys = Object.keys(files);
    expect(keys).toContain("src/lib/hono/index.ts");
    expect(keys).toContain("src/lib/hono/routes/health.ts");
    expect(keys).toContain("src/lib/hono/routes/users.ts");
    expect(keys).toContain("src/lib/hono/client.ts");
    expect(keys).toContain("src/app/api/[[...route]]/route.ts");
  });

  test("with hono: false omits all hono files", () => {
    const files = getTemplates(opts({ hono: false }));
    const keys = Object.keys(files);
    expect(keys).not.toContain("src/lib/hono/index.ts");
    expect(keys).not.toContain("src/lib/hono/client.ts");
    expect(keys).not.toContain("src/app/api/[[...route]]/route.ts");
  });

  test("with themes: true includes provider and toggle", () => {
    const files = getTemplates(opts({ themes: true }));
    expect(Object.keys(files)).toContain("src/components/theme-provider.tsx");
    expect(Object.keys(files)).toContain("src/components/theme-toggle.tsx");
  });

  test("with themes: false omits theme files", () => {
    const files = getTemplates(opts({ themes: false }));
    expect(Object.keys(files)).not.toContain("src/components/theme-provider.tsx");
  });

  test("with testing: true includes vitest config and setup", () => {
    const files = getTemplates(opts({ testing: true }));
    const keys = Object.keys(files);
    expect(keys).toContain("vitest.config.ts");
    expect(keys).toContain("vitest.setup.ts");
    expect(keys).toContain("src/app/page.test.tsx");
  });

  test("with testing: true and hono: true includes hono health test", () => {
    const files = getTemplates(opts({ testing: true, hono: true }));
    expect(Object.keys(files)).toContain("src/lib/hono/routes/health.test.ts");
  });

  test("with testing: true and hono: false omits hono health test", () => {
    const files = getTemplates(opts({ testing: true, hono: false }));
    expect(Object.keys(files)).not.toContain("src/lib/hono/routes/health.test.ts");
  });

  test("with ci: true includes github actions workflow", () => {
    const files = getTemplates(opts({ ci: true }));
    expect(Object.keys(files)).toContain(".github/workflows/ci.yml");
  });

  test("with ci: false omits github actions workflow", () => {
    const files = getTemplates(opts({ ci: false }));
    expect(Object.keys(files)).not.toContain(".github/workflows/ci.yml");
  });

  test("all template values are non-empty strings", () => {
    const files = getTemplates(opts({ hono: true, themes: true, testing: true, ci: true }));
    for (const [path, content] of Object.entries(files)) {
      expect(content, `template ${path} is empty`).toBeTruthy();
      expect(typeof content).toBe("string");
    }
  });

  test("landing page with shadcn uses Card/Badge components", () => {
    const files = getTemplates(opts({ shadcn: true }));
    expect(files["src/app/page.tsx"]).toContain('from "@/components/ui/card"');
    expect(files["src/app/page.tsx"]).toContain("AQT Stack");
  });

  test("landing page without shadcn uses plain divs", () => {
    const files = getTemplates(opts({ shadcn: false }));
    const page = files["src/app/page.tsx"]!;
    expect(page).toContain("AQT Stack");
    expect(page).not.toContain('from "@/components/ui/card"');
  });

  test("landing page with themes includes ThemeToggle", () => {
    const files = getTemplates(opts({ themes: true }));
    expect(files["src/app/page.tsx"]).toContain("ThemeToggle");
  });

  test("hono client exports typed api const", () => {
    const files = getTemplates(opts({ hono: true }));
    const client = files["src/lib/hono/client.ts"]!;
    expect(client).toContain("AppType");
    expect(client).toContain("export const api");
    expect(client).toContain("hc<AppType>");
  });

  test("users route uses valibot validator", () => {
    const files = getTemplates(opts({ hono: true }));
    const users = files["src/lib/hono/routes/users.ts"]!;
    expect(users).toContain("@hono/valibot-validator");
    expect(users).toContain("vValidator");
    expect(users).toContain('import * as v from "valibot"');
  });

  test("env template uses valibot", () => {
    const files = getTemplates(opts());
    expect(files["src/lib/env.ts"]).toContain('import * as v from "valibot"');
    expect(files["src/lib/env.ts"]).toContain("@t3-oss/env-nextjs");
  });

  test("ci workflow includes test step when testing is enabled", () => {
    const files = getTemplates(opts({ ci: true, testing: true }));
    expect(files[".github/workflows/ci.yml"]).toContain("bun run test");
  });

  test("ci workflow omits test step when testing is disabled", () => {
    const files = getTemplates(opts({ ci: true, testing: false }));
    expect(files[".github/workflows/ci.yml"]).not.toContain("bun run test");
  });

  test("hono API route template contains all HTTP method exports", () => {
    const files = getTemplates(opts({ hono: true }));
    const route = files["src/app/api/[[...route]]/route.ts"]!;
    expect(route).toContain("export const GET");
    expect(route).toContain("export const POST");
    expect(route).toContain("export const PUT");
    expect(route).toContain("export const DELETE");
    expect(route).toContain("export const PATCH");
  });

  test("users route contains CRUD handlers", () => {
    const files = getTemplates(opts({ hono: true }));
    const users = files["src/lib/hono/routes/users.ts"]!;
    expect(users).toContain('.get("/users"');
    expect(users).toContain('.post("/users"');
    expect(users).toContain('.get("/users/:id"');
    expect(users).toContain('.delete("/users/:id"');
  });
});

import { describe, expect, test } from "bun:test";

import { buildCi, getTemplates, type TemplateOptions } from "../templates.ts";

const defaults: TemplateOptions = {
  projectName: "example",
  hono: true,
  ui: true,
  themes: true,
  testing: true,
};

describe("generated app", () => {
  test("all option combinations have matching imports and files", () => {
    for (const hono of [false, true])
      for (const ui of [false, true])
        for (const themes of [false, true])
          for (const testing of [false, true]) {
            const files = getTemplates({ ...defaults, hono, ui, themes, testing });
            expect(Boolean(files["src/lib/hono/index.ts"])).toBe(hono);
            expect(Boolean(files["components.json"])).toBe(ui);
            expect(Boolean(files["src/app/page.test.tsx"])).toBe(testing);
            expect(files["src/app/page.tsx"]!.includes("@aqt/ui/components/card")).toBe(ui);
            expect(files["src/app/layout.tsx"]!.includes("<ThemeProvider")).toBe(ui && themes);
            expect(files["src/app/globals.css"]!.includes("@aqt/ui/styles/globals.css")).toBe(ui);
            expect(files["next.config.ts"]!.includes('transpilePackages: ["@aqt/ui"]')).toBe(ui);
            expect(files["src/app/page.tsx"]!.includes("/api/health")).toBe(hono);
            expect(JSON.stringify(files)).not.toMatch(/valibot|prettier|eslint|next\/font/);
          }
  });

  test("inherits strict TypeScript without overriding shared strictness flags", () => {
    const files = getTemplates(defaults);
    expect(JSON.parse(files["tsconfig.json"]!)).toMatchObject({
      extends: "@aqt/config/tsconfig.base.json",
      compilerOptions: { paths: { "@/*": ["./src/*"] } },
    });
    expect(files["tsconfig.json"]).not.toContain("noUncheckedIndexedAccess");
    expect(files["next.config.ts"]).toContain("reactCompiler: true");
    expect(files["next.config.ts"]).toContain('import "./src/lib/env"');
    expect(files["src/lib/env.ts"]).toContain('from "arktype"');
    expect(files["src/lib/hono/routes/users.ts"]).toContain('sValidator("json", createUserSchema)');
  });

  test("workflow installs at root, checks the app, and reacts to shared configuration", () => {
    const ci = buildCi(defaults);
    expect(ci).toContain("install_args: bun");
    expect(ci).toContain("bun install --frozen-lockfile");
    expect(ci).toContain("working-directory: apps/example");
    expect(ci).toContain("packages/ts/config/**");
    expect(ci).toContain("bun run check");
    expect(ci).toContain("bun run build");
  });
});

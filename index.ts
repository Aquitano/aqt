import { cancel, confirm, intro, isCancel, log, multiselect, outro, select, spinner, text } from '@clack/prompts';
import { $ } from 'bun';

// ── Prettier presets ──────────────────────────────────────────────

const PRETTIER_PRESETS = {
    default: {
        semi: true,
        singleQuote: true,
        trailingComma: 'all',
        tabWidth: 2,
        printWidth: 100,
        plugins: ['prettier-plugin-tailwindcss'],
    },
    relaxed: {
        semi: false,
        singleQuote: true,
        trailingComma: 'none',
        tabWidth: 2,
        printWidth: 120,
        plugins: ['prettier-plugin-tailwindcss'],
    },
    strict: {
        semi: true,
        singleQuote: true,
        trailingComma: 'all',
        tabWidth: 2,
        printWidth: 80,
        plugins: ['prettier-plugin-tailwindcss'],
    },
} as const;

type PrettierPreset = keyof typeof PRETTIER_PRESETS;

// ── shadcn/ui component catalog ──────────────────────────────────

const SHADCN_COMPONENTS = [
    { value: 'button', label: 'Button', hint: 'Standard button' },
    { value: 'input', label: 'Input', hint: 'Text input field' },
    { value: 'label', label: 'Label', hint: 'Form label' },
    { value: 'card', label: 'Card', hint: 'Content container' },
    { value: 'separator', label: 'Separator', hint: 'Visual divider' },
    { value: 'dialog', label: 'Dialog', hint: 'Modal dialog' },
    { value: 'dropdown-menu', label: 'Dropdown Menu', hint: 'Context menu' },
    { value: 'form', label: 'Form', hint: 'Form with validation' },
    { value: 'select', label: 'Select', hint: 'Dropdown select' },
    { value: 'sheet', label: 'Sheet', hint: 'Slide-out panel' },
    { value: 'sonner', label: 'Sonner', hint: 'Toast notifications' },
    { value: 'table', label: 'Table', hint: 'Data table' },
    { value: 'tabs', label: 'Tabs', hint: 'Tab navigation' },
    { value: 'textarea', label: 'Textarea', hint: 'Multi-line input' },
    { value: 'avatar', label: 'Avatar', hint: 'User avatar' },
    { value: 'badge', label: 'Badge', hint: 'Status badge' },
    { value: 'checkbox', label: 'Checkbox', hint: 'Checkbox input' },
    { value: 'command', label: 'Command', hint: 'Command palette' },
    { value: 'popover', label: 'Popover', hint: 'Floating content' },
    { value: 'skeleton', label: 'Skeleton', hint: 'Loading placeholder' },
];

const DEFAULT_SHADCN_COMPONENTS = ['button', 'input', 'label', 'card', 'separator'];

// ── Generated file map ───────────────────────────────────────────
// Every file the scaffolding writes after create-next-app finishes.
// Keys are paths relative to the project root.

const FILES: Record<string, string> = {
    // Hono API backend
    'src/lib/hono/index.ts': `import { Hono } from "hono";
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
`,

    'src/lib/hono/routes/health.ts': `import { Hono } from "hono";

export const healthRoute = new Hono().get("/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);
`,

    'src/lib/hono/routes/users.ts': `import { Hono } from "hono";

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
`,

    'src/app/api/[[...route]]/route.ts': `import app from "@/lib/hono";
import { handle } from "hono/vercel";

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const DELETE = handle(app);
export const PATCH = handle(app);
`,

    // Landing page (replaces create-next-app default)
    'src/app/page.tsx': `import { buttonVariants } from "@/components/ui/button";
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
`,
};

// ── Layout patches ───────────────────────────────────────────────
// Applied to files generated by create-next-app.

const LAYOUT_PATCHES: [string, string][] = [
    [`title: "Create Next App"`, `title: "AQT Stack"`],
    [`description: "Generated by create next app"`, `description: "Next.js + Hono + Tailwind + shadcn/ui"`],
    [
        `className={\`\${geistSans.variable} \${geistMono.variable}\`}`,
        `className={\`\${geistSans.variable} \${geistMono.variable} h-full antialiased\`}`,
    ],
    [`<body>`, `<body className="min-h-full flex flex-col">`],
];

const NEXT_CONFIG_PATCH: [string, string] = [`/* config options here */`, `reactCompiler: true,`];

// ── Types ────────────────────────────────────────────────────────

interface Config {
    projectName: string;
    eslint: boolean;
    prettier: boolean;
    prettierPreset: PrettierPreset;
    shadcn: boolean;
    shadcnComponents: string[];
    hono: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────

function unwrap<T>(value: T | symbol): T {
    if (isCancel(value)) {
        cancel('Operation cancelled.');
        process.exit(0);
    }
    return value;
}

async function step(label: string, fn: () => Promise<void>, { verbose = false } = {}): Promise<void> {
    if (verbose) {
        log.info(`${label}…`);
        await fn();
        log.success(`${label} ✓`);
    } else {
        const s = spinner();
        s.start(`${label}…`);
        try {
            await fn();
            s.stop(`${label} ✓`);
        } catch (err) {
            s.stop(`${label} ✗`);
            throw err;
        }
    }
}

function die(err: unknown): never {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Bootstrapping failed: ${msg}`);
    process.exit(1);
}

async function patchFile(path: string, patches: [string, string][]): Promise<void> {
    let content = await Bun.file(path).text();
    for (const [from, to] of patches) {
        content = content.replace(from, to);
    }
    await Bun.write(path, content);
}

// ── Interactive prompts ──────────────────────────────────────────

async function promptConfig(): Promise<Config> {
    const projectName = unwrap(
        await text({
            message: 'Project name',
            placeholder: 'my-app',
            validate(value) {
                if (!value) return 'Project name is required.';
                if (!/^[a-zA-Z0-9@._/-]+$/.test(value))
                    return 'Use only letters, numbers, hyphens, underscores, dots, and slashes.';
            },
        }),
    );

    const eslint = unwrap(await confirm({ message: 'Add ESLint?', initialValue: true }));

    const usePrettier = unwrap(await confirm({ message: 'Configure Prettier?', initialValue: true }));

    let prettierPreset: PrettierPreset = 'default';
    if (usePrettier) {
        prettierPreset = unwrap(
            await select({
                message: 'Prettier preset',
                options: [
                    {
                        value: 'default',
                        label: 'Default',
                        hint: 'Semi, single quotes, trailing commas, 100 width',
                    },
                    {
                        value: 'relaxed',
                        label: 'Relaxed',
                        hint: 'No semi, no trailing commas, 120 width',
                    },
                    {
                        value: 'strict',
                        label: 'Strict',
                        hint: 'Semi, trailing commas, 80 width',
                    },
                ],
            }),
        ) as PrettierPreset;
    }

    const useShadcn = unwrap(await confirm({ message: 'Add shadcn/ui?', initialValue: true }));

    let shadcnComponents: string[] = [];
    if (useShadcn) {
        shadcnComponents = unwrap(
            await multiselect({
                message: 'Select shadcn/ui components to install',
                options: SHADCN_COMPONENTS,
                initialValues: DEFAULT_SHADCN_COMPONENTS,
                required: false,
            }),
        ) as string[];
    }

    const useHono = unwrap(await confirm({ message: 'Add Hono.js API backend?', initialValue: true }));

    return {
        projectName: projectName as string,
        eslint,
        prettier: usePrettier,
        prettierPreset,
        shadcn: useShadcn,
        shadcnComponents,
        hono: useHono,
    };
}

// ── Scaffolding steps ────────────────────────────────────────────

async function scaffoldNextjs(config: Config): Promise<void> {
    const flags = [
        config.projectName,
        '--typescript',
        '--tailwind',
        '--app',
        '--src-dir',
        '--import-alias="@/*"',
        '--use-bun',
    ];

    flags.push(config.eslint ? '--eslint' : '--no-eslint');

    const proc = Bun.spawn(['bunx', 'create-next-app@latest', ...flags], {
        stdio: ['inherit', 'inherit', 'inherit'],
        cwd: process.cwd(),
    });

    if ((await proc.exited) !== 0) {
        throw new Error('create-next-app failed');
    }
}

async function setupPrettier(config: Config, projectPath: string): Promise<void> {
    const preset = PRETTIER_PRESETS[config.prettierPreset];

    await $`bun add -d prettier prettier-plugin-tailwindcss`.cwd(projectPath).quiet();

    await Bun.write(`${projectPath}/.prettierrc`, JSON.stringify(preset, null, 2) + '\n');

    const pkgPath = `${projectPath}/package.json`;
    const pkg = await Bun.file(pkgPath).json();
    pkg.scripts ??= {};
    pkg.scripts.format = 'prettier --write .';
    pkg.scripts['format:check'] = 'prettier --check .';
    await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

async function setupShadcn(config: Config, projectPath: string): Promise<void> {
    const initProc = Bun.spawn(['bunx', 'shadcn@latest', 'init', '-d'], {
        stdio: ['inherit', 'inherit', 'inherit'],
        cwd: projectPath,
    });
    if ((await initProc.exited) !== 0) {
        throw new Error('shadcn init failed');
    }

    if (config.shadcnComponents.length > 0) {
        const addProc = Bun.spawn(['bunx', 'shadcn@latest', 'add', ...config.shadcnComponents], {
            stdio: ['inherit', 'inherit', 'inherit'],
            cwd: projectPath,
        });
        if ((await addProc.exited) !== 0) {
            throw new Error('shadcn add failed');
        }
    }
}

async function applyCustomizations(config: Config, projectPath: string): Promise<void> {
    // Install extra packages
    if (config.hono) {
        await $`bun add hono`.cwd(projectPath).quiet();
    }
    await $`bun add -d babel-plugin-react-compiler`.cwd(projectPath).quiet();

    // Patch create-next-app generated files
    await patchFile(`${projectPath}/next.config.ts`, [NEXT_CONFIG_PATCH]);
    await patchFile(`${projectPath}/src/app/layout.tsx`, LAYOUT_PATCHES);

    // Write all generated files (hono, landing page, agent rules)
    const filesToWrite = config.hono
        ? FILES
        : Object.fromEntries(
              Object.entries(FILES).filter(([p]) => !p.startsWith('src/lib/hono/') && !p.startsWith('src/app/api/')),
          );

    for (const [rel, content] of Object.entries(filesToWrite)) {
        const fullPath = `${projectPath}/${rel}`;
        const dir = fullPath.replace(/\/[^/]+$/, '');
        await $`mkdir -p ${dir}`.cwd(projectPath).quiet();
        await Bun.write(fullPath, content);
    }
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const args = Bun.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        console.log(
            `\n  AQT Stack · App Bootstrapper\n\n  An interactive CLI to scaffold Next.js + Tailwind + shadcn/ui + Hono.js projects.\n\n  Usage: bun run index.ts\n`,
        );
        process.exit(0);
    }

    intro('AQT Stack · App Bootstrapper');

    const config = await promptConfig();

    log.info('Configuration:');
    log.info(`  Project:   ${config.projectName}`);
    log.info(`  TypeScript: yes`);
    log.info(`  Tailwind:   yes`);
    log.info(`  ESLint:     ${config.eslint ? 'yes' : 'no'}`);
    log.info(`  Prettier:   ${config.prettier ? config.prettierPreset : 'no'}`);
    log.info(`  shadcn/ui:  ${config.shadcn ? `${config.shadcnComponents.length} components` : 'no'}`);
    log.info(`  Hono.js:    ${config.hono ? 'yes' : 'no'}`);

    const proceed = unwrap(
        await confirm({
            message: 'Proceed with scaffolding?',
            initialValue: true,
        }),
    );
    if (!proceed) {
        cancel('Scaffolding cancelled.');
        process.exit(0);
    }

    const projectPath = `${process.cwd()}/${config.projectName}`;

    await step('Scaffolding Next.js', () => scaffoldNextjs(config), {
        verbose: true,
    });

    if (config.prettier) {
        await step('Configuring Prettier', () => setupPrettier(config, projectPath));
    }

    if (config.shadcn) {
        await step('Initializing shadcn/ui', () => setupShadcn(config, projectPath));
    }

    await step('Applying AQT Stack customizations', () => applyCustomizations(config, projectPath));

    outro(`Done! Your project is ready at ./${config.projectName}`);
    log.info(`  cd ${config.projectName}`);
    log.info('  bun dev\n');
}

main().catch(die);

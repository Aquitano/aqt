import { log } from "@clack/prompts";

import type { Config } from "./config.ts";
import { PRETTIER_PRESETS, REQUIRED_LANDING_COMPONENTS } from "./config.ts";
import {
  applyPatches,
  GITIGNORE_ENV_PATCH,
  LAYOUT_PATCHES,
  NEXT_CONFIG_PATCH,
  THEME_LAYOUT_PATCHES,
  type Patch,
  type PatchResult,
} from "./patcher.ts";
import type { ShellRunner } from "./shell.ts";
import { getTemplates } from "./templates.ts";

// ── Helpers ──────────────────────────────────────────────────────

/** Warn loudly when a patch's search string was not found, instead of failing silently. */
function warnMissed(result: PatchResult, file: string): void {
  if (result.missed.length > 0) {
    log.warn(
      `Could not apply ${result.missed.length} patch(es) to ${file}: ${result.missed.join(", ")}. ` +
        `The upstream template may have changed — review this file manually.`,
    );
  }
}

async function patchFile(
  shell: ShellRunner,
  path: string,
  patches: Patch[],
  label: string,
): Promise<void> {
  const content = await shell.readFile(path);
  const result = applyPatches(content, patches);
  await shell.writeFile(path, result.content);
  warnMissed(result, label);
}

// ── Scaffold steps ───────────────────────────────────────────────

async function scaffoldNextjs(config: Config, shell: ShellRunner): Promise<void> {
  const flags = [
    config.projectName,
    "--typescript",
    "--tailwind",
    "--app",
    "--src-dir",
    "--react-compiler",
    "--import-alias",
    "@/*",
    "--use-bun",
  ];

  flags.push(config.eslint ? "--eslint" : "--no-eslint");

  await shell.spawn("bunx", ["create-next-app@latest", ...flags], {
    cwd: process.cwd(),
  });
}

async function setupPrettier(
  config: Config,
  projectPath: string,
  shell: ShellRunner,
): Promise<void> {
  const preset = PRETTIER_PRESETS[config.prettierPreset];

  await shell.install(["prettier", "prettier-plugin-tailwindcss"], {
    cwd: projectPath,
    dev: true,
  });

  await shell.writeFile(`${projectPath}/.prettierrc`, JSON.stringify(preset, null, 2) + "\n");

  const pkg = await shell.readJson<{ scripts?: Record<string, string> }>(
    `${projectPath}/package.json`,
  );
  pkg.scripts ??= {};
  pkg.scripts.format = "prettier --write .";
  pkg.scripts["format:check"] = "prettier --check .";
  await shell.writeFile(`${projectPath}/package.json`, JSON.stringify(pkg, null, 2) + "\n");
}

async function setupShadcn(config: Config, projectPath: string, shell: ShellRunner): Promise<void> {
  await shell.spawn("bunx", ["shadcn@latest", "init", "-d"], { cwd: projectPath });

  // Union the user's selection with the components the landing page imports,
  // so the generated page always compiles regardless of what was ticked.
  const components = [...new Set([...config.shadcnComponents, ...REQUIRED_LANDING_COMPONENTS])];
  if (components.length > 0) {
    await shell.spawn("bunx", ["shadcn@latest", "add", ...components], {
      cwd: projectPath,
    });
  }
}

async function installDependencies(
  config: Config,
  projectPath: string,
  shell: ShellRunner,
): Promise<void> {
  // Validation + env are part of the base stack.
  const prod = ["valibot", "@t3-oss/env-nextjs"];
  if (config.hono) prod.push("hono", "@hono/valibot-validator");
  if (config.themes) prod.push("next-themes", "lucide-react");
  await shell.install(prod, { cwd: projectPath });

  const dev = ["babel-plugin-react-compiler"];
  if (config.testing) {
    dev.push(
      "vitest",
      "@vitejs/plugin-react",
      "vite-tsconfig-paths",
      "jsdom",
      "@testing-library/react",
      "@testing-library/jest-dom",
      "@testing-library/user-event",
    );
  }
  await shell.install(dev, { cwd: projectPath, dev: true });
}

async function setupScripts(
  config: Config,
  projectPath: string,
  shell: ShellRunner,
): Promise<void> {
  const pkg = await shell.readJson<{ scripts?: Record<string, string> }>(
    `${projectPath}/package.json`,
  );
  pkg.scripts ??= {};
  pkg.scripts.typecheck = "tsc --noEmit";
  if (config.testing) {
    pkg.scripts.test = "vitest run";
    pkg.scripts["test:watch"] = "vitest";
  }
  await shell.writeFile(`${projectPath}/package.json`, JSON.stringify(pkg, null, 2) + "\n");
}

async function applyCustomizations(
  config: Config,
  projectPath: string,
  shell: ShellRunner,
): Promise<void> {
  await installDependencies(config, projectPath, shell);
  await setupScripts(config, projectPath, shell);

  // Patch create-next-app generated files.
  await patchFile(shell, `${projectPath}/next.config.ts`, [NEXT_CONFIG_PATCH], "next.config.ts");

  const layoutPatches = config.themes
    ? [...LAYOUT_PATCHES, ...THEME_LAYOUT_PATCHES]
    : LAYOUT_PATCHES;
  await patchFile(shell, `${projectPath}/src/app/layout.tsx`, layoutPatches, "src/app/layout.tsx");

  // Keep .env.example committed even though create-next-app ignores .env*.
  await patchFile(shell, `${projectPath}/.gitignore`, [GITIGNORE_ENV_PATCH], ".gitignore");

  // Write all generated files (landing page, hono, env, themes, tests, ci).
  const templates = getTemplates({
    hono: config.hono,
    shadcn: config.shadcn,
    themes: config.themes,
    testing: config.testing,
    ci: config.ci,
    eslint: config.eslint,
    prettier: config.prettier,
  });

  for (const [rel, content] of Object.entries(templates)) {
    const fullPath = `${projectPath}/${rel}`;
    const dir = fullPath.replace(/\/[^/]+$/, "");
    await shell.mkdir(dir, projectPath);
    await shell.writeFile(fullPath, content);
  }
}

async function finalizeGit(projectPath: string, shell: ShellRunner): Promise<void> {
  // create-next-app already runs `git init` + an initial commit; record our
  // customizations as a follow-up commit. Tolerate failure (e.g. missing git
  // identity) without aborting the whole scaffold.
  try {
    await shell.spawn("git", ["add", "-A"], { cwd: projectPath });
    await shell.spawn("git", ["commit", "-m", "chore: scaffold AQT Stack"], { cwd: projectPath });
  } catch {
    log.warn("Could not create a git commit (is git configured?). Skipping.");
  }
}

// ── Pipeline ─────────────────────────────────────────────────────

export type StepRunner = (
  label: string,
  fn: () => Promise<void>,
  opts?: { verbose?: boolean },
) => Promise<void>;

/**
 * Run the full scaffolding pipeline.
 * Each step is wrapped through `runStep` for UI feedback (spinner, logging).
 * Conditional steps are gated by config flags.
 */
export async function scaffold(
  config: Config,
  shell: ShellRunner,
  runStep: StepRunner,
): Promise<void> {
  const projectPath = `${process.cwd()}/${config.projectName}`;

  await runStep("Scaffolding Next.js", () => scaffoldNextjs(config, shell), { verbose: true });

  if (config.prettier) {
    await runStep("Configuring Prettier", () => setupPrettier(config, projectPath, shell));
  }

  if (config.shadcn) {
    await runStep("Initializing shadcn/ui", () => setupShadcn(config, projectPath, shell));
  }

  await runStep("Applying AQT Stack customizations", () =>
    applyCustomizations(config, projectPath, shell),
  );

  await runStep("Finalizing git", () => finalizeGit(projectPath, shell));
}

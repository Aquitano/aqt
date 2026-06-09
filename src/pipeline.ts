import type { Config } from './config.ts';
import { PRETTIER_PRESETS } from './config.ts';
import { getTemplates } from './templates.ts';
import { applyPatches, LAYOUT_PATCHES, NEXT_CONFIG_PATCH } from './patcher.ts';
import type { ShellRunner } from './shell.ts';

// ── Scaffold steps ───────────────────────────────────────────────

async function scaffoldNextjs(config: Config, shell: ShellRunner): Promise<void> {
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

  await shell.spawn('bunx', ['create-next-app@latest', ...flags], {
    cwd: process.cwd(),
  });
}

async function setupPrettier(config: Config, projectPath: string, shell: ShellRunner): Promise<void> {
  const preset = PRETTIER_PRESETS[config.prettierPreset];

  await shell.install(['prettier', 'prettier-plugin-tailwindcss'], {
    cwd: projectPath,
    dev: true,
  });

  await shell.writeFile(`${projectPath}/.prettierrc`, JSON.stringify(preset, null, 2) + '\n');

  const pkg = await shell.readJson<{ scripts?: Record<string, string> }>(
    `${projectPath}/package.json`,
  );
  pkg.scripts ??= {};
  pkg.scripts.format = 'prettier --write .';
  pkg.scripts['format:check'] = 'prettier --check .';
  await shell.writeFile(`${projectPath}/package.json`, JSON.stringify(pkg, null, 2) + '\n');
}

async function setupShadcn(config: Config, projectPath: string, shell: ShellRunner): Promise<void> {
  await shell.spawn('bunx', ['shadcn@latest', 'init', '-d'], { cwd: projectPath });

  if (config.shadcnComponents.length > 0) {
    await shell.spawn('bunx', ['shadcn@latest', 'add', ...config.shadcnComponents], {
      cwd: projectPath,
    });
  }
}

async function applyCustomizations(
  config: Config,
  projectPath: string,
  shell: ShellRunner,
): Promise<void> {
  if (config.hono) {
    await shell.install(['hono'], { cwd: projectPath });
  }
  await shell.install(['babel-plugin-react-compiler'], { cwd: projectPath, dev: true });

  // Patch create-next-app generated files
  const nextConfigPath = `${projectPath}/next.config.ts`;
  const nextConfig = await shell.readFile(nextConfigPath);
  const ncResult = applyPatches(nextConfig, [NEXT_CONFIG_PATCH]);
  await shell.writeFile(nextConfigPath, ncResult.content);

  const layoutPath = `${projectPath}/src/app/layout.tsx`;
  const layout = await shell.readFile(layoutPath);
  const layoutResult = applyPatches(layout, LAYOUT_PATCHES);
  await shell.writeFile(layoutPath, layoutResult.content);

  // Write all generated files (hono, landing page)
  const templates = getTemplates({ hono: config.hono });

  for (const [rel, content] of Object.entries(templates)) {
    const fullPath = `${projectPath}/${rel}`;
    const dir = fullPath.replace(/\/[^/]+$/, '');
    await shell.mkdir(dir, projectPath);
    await shell.writeFile(fullPath, content);
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

  await runStep('Scaffolding Next.js', () => scaffoldNextjs(config, shell), { verbose: true });

  if (config.prettier) {
    await runStep('Configuring Prettier', () => setupPrettier(config, projectPath, shell));
  }

  if (config.shadcn) {
    await runStep('Initializing shadcn/ui', () => setupShadcn(config, projectPath, shell));
  }

  await runStep(
    'Applying AQT Stack customizations',
    () => applyCustomizations(config, projectPath, shell),
  );
}

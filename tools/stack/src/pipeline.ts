import { resolve } from "node:path";

import type { Config } from "./config.ts";
import { validateProjectName } from "./config.ts";
import { buildMiseTasks, validateMiseNamespace } from "./mise.ts";
import type { ShellRunner } from "./shell.ts";
import { buildCi, getTemplates } from "./templates.ts";

// Bump together with a real scaffold/build smoke test.
export const NEXT_GENERATOR = "create-next-app@16.3.8";
export const WORKSPACE_ROOT = resolve(import.meta.dir, "../../..");

export type StepRunner = (
  label: string,
  fn: () => Promise<void>,
  opts?: { verbose?: boolean },
) => Promise<void>;

export async function scaffold(
  config: Config,
  shell: ShellRunner,
  runStep: StepRunner,
  workspaceRoot = WORKSPACE_ROOT,
): Promise<void> {
  const nameError = validateProjectName(config.projectName);
  if (nameError) throw new Error(nameError);
  const projectPath = resolve(workspaceRoot, "apps", config.projectName);
  const workflowPath = resolve(workspaceRoot, ".github/workflows", `${config.projectName}.yml`);
  const taskPath = resolve(workspaceRoot, "tools/tasks", `${config.projectName}.toml`);
  const rootPackage = await shell.readPackageJson(`${workspaceRoot}/package.json`);
  if (
    rootPackage.name !== "aqt" ||
    !(await shell.exists(`${workspaceRoot}/packages/ts/config/package.json`))
  ) {
    throw new Error("Run the generator from its aqt workspace checkout.");
  }
  if (await shell.exists(projectPath)) throw new Error(`App already exists: ${projectPath}`);
  if (config.ci && (await shell.exists(workflowPath))) {
    throw new Error(`Workflow already exists: ${workflowPath}`);
  }
  if (await shell.exists(taskPath)) throw new Error(`Task file already exists: ${taskPath}`);
  validateMiseNamespace(
    await shell.readFile(`${workspaceRoot}/mise.toml`),
    config.projectName,
    await shell.taskNames(workspaceRoot),
  );
  await shell.reserveDirectory(projectPath);

  await runStep(
    "Creating Next.js app",
    () =>
      shell.spawn(
        "bunx",
        [
          NEXT_GENERATOR,
          projectPath,
          "--typescript",
          "--tailwind",
          "--app",
          "--src-dir",
          "--react-compiler",
          "--import-alias",
          "@/*",
          "--use-bun",
          "--no-eslint",
          "--no-biome",
          "--skip-install",
          "--disable-git",
          "--yes",
        ],
        { cwd: workspaceRoot },
      ),
    { verbose: true },
  );

  await runStep("Applying workspace configuration", async () => {
    const pkg = await shell.readPackageJson(`${projectPath}/package.json`);
    pkg.name = `@aqt/${config.projectName}`;
    pkg.private = true;
    pkg.type = "module";
    delete pkg.packageManager;
    pkg.scripts = {
      dev: "next dev",
      build: "next build",
      start: "next start",
      lint: "vp lint --nextjs-plugin",
      fmt: "vp fmt",
      "fmt:check": "vp fmt --check",
      typecheck: "next typegen && tsc --noEmit",
      check:
        "bun run lint && bun run fmt:check && bun run typecheck" +
        (config.testing ? " && bun run test" : ""),
    };
    if (config.testing) {
      pkg.scripts.test = "vp test run";
      pkg.scripts["test:watch"] = "vp test";
    }
    pkg.dependencies ??= {};
    // create-next-app pins its own React; @aqt/ui hooks fail against a second copy.
    pkg.dependencies.react = "catalog:";
    pkg.dependencies["react-dom"] = "catalog:";
    pkg.dependencies["@aqt/ui"] = "workspace:*";
    pkg.devDependencies ??= {};
    pkg.devDependencies["@aqt/config"] = "workspace:*";
    pkg.devDependencies["vite-plus"] = "catalog:";
    const typescript = rootPackage.devDependencies?.typescript;
    if (!typescript) throw new Error("The workspace must declare a TypeScript version.");
    pkg.devDependencies.typescript = typescript;
    await shell.writeFile(`${projectPath}/package.json`, JSON.stringify(pkg, null, 2) + "\n");

    await Promise.all(
      Object.entries(getTemplates(config)).map(async ([path, content]) => {
        const fullPath = resolve(projectPath, path);
        await shell.mkdir(resolve(fullPath, ".."), workspaceRoot);
        await shell.writeFile(fullPath, content);
      }),
    );
    await shell.spawn("bun", ["install"], { cwd: workspaceRoot });
    const dependencies = ["arktype", "@t3-oss/env-nextjs"];
    if (config.hono) dependencies.push("hono", "@hono/standard-validator");
    await shell.install(dependencies, { cwd: projectPath });
    if (config.testing) {
      await shell.install(
        [
          "@vitejs/plugin-react",
          "jsdom",
          "@testing-library/react",
          "@testing-library/jest-dom",
          "@testing-library/user-event",
        ],
        { cwd: projectPath, dev: true },
      );
    }
  });

  if (config.ci) {
    await runStep("Adding app CI workflow", async () => {
      await shell.mkdir(resolve(workflowPath, ".."), workspaceRoot);
      await shell.writeFile(workflowPath, buildCi(config));
      await shell.spawn("bunx", ["--no-install", "vp", "fmt", workflowPath], {
        cwd: workspaceRoot,
      });
    });
  }

  await runStep(
    "Formatting and checking the app",
    async () => {
      await shell.spawn("bun", ["run", "fmt"], { cwd: projectPath });
      await shell.spawn("bun", ["run", "check"], { cwd: projectPath });
      await shell.spawn("bun", ["run", "build"], { cwd: projectPath });
    },
    { verbose: true },
  );

  await runStep("Registering mise entry points", async () => {
    await shell.mkdir(resolve(taskPath, ".."), workspaceRoot);
    await shell.writeFile(taskPath, buildMiseTasks(config.projectName));
    await shell.spawn("mise", ["run", "-n", `${config.projectName}:check`], { cwd: workspaceRoot });
  });
}

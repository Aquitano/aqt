import { confirm, multiselect, select, text } from "@clack/prompts";

import type { Config, PrettierPreset } from "./config.ts";
import { DEFAULT_SHADCN_COMPONENTS, SHADCN_COMPONENTS } from "./config.ts";
import { unwrap } from "./helpers.ts";

const PRETTIER_PRESET_OPTIONS: { value: PrettierPreset; label: string; hint: string }[] = [
  {
    value: "default",
    label: "Default",
    hint: "Semi, single quotes, trailing commas, 100 width",
  },
  {
    value: "relaxed",
    label: "Relaxed",
    hint: "No semi, no trailing commas, 120 width",
  },
  {
    value: "strict",
    label: "Strict",
    hint: "Semi, trailing commas, 80 width",
  },
];

export async function promptConfig(): Promise<Config> {
  const projectName = unwrap(
    await text({
      message: "Project name",
      placeholder: "my-app",
      validate(value) {
        if (!value) return "Project name is required.";
        if (!/^[a-zA-Z0-9@._/-]+$/.test(value))
          return "Use only letters, numbers, hyphens, underscores, dots, and slashes.";
      },
    }),
  );

  const eslint = unwrap(await confirm({ message: "Add ESLint?", initialValue: true }));

  const usePrettier = unwrap(await confirm({ message: "Configure Prettier?", initialValue: true }));

  let prettierPreset: PrettierPreset = "default";
  if (usePrettier) {
    prettierPreset = unwrap(
      await select({ message: "Prettier preset", options: PRETTIER_PRESET_OPTIONS }),
    );
  }

  const useShadcn = unwrap(await confirm({ message: "Add shadcn/ui?", initialValue: true }));

  let shadcnComponents: string[] = [];
  if (useShadcn) {
    shadcnComponents = unwrap(
      await multiselect({
        message: "Select shadcn/ui components to install",
        options: SHADCN_COMPONENTS,
        initialValues: DEFAULT_SHADCN_COMPONENTS,
        required: false,
      }),
    );
  }

  const useHono = unwrap(
    await confirm({ message: "Add Hono.js API backend?", initialValue: true }),
  );

  const useThemes = unwrap(
    await confirm({ message: "Add dark mode (next-themes + toggle)?", initialValue: true }),
  );

  const useTesting = unwrap(
    await confirm({ message: "Add testing (Vitest + Testing Library)?", initialValue: true }),
  );

  const useCi = unwrap(
    await confirm({ message: "Add GitHub Actions CI workflow?", initialValue: true }),
  );

  return {
    projectName,
    eslint,
    prettier: usePrettier,
    prettierPreset,
    shadcn: useShadcn,
    shadcnComponents,
    hono: useHono,
    themes: useThemes,
    testing: useTesting,
    ci: useCi,
  };
}

import { confirm, multiselect, text } from "@clack/prompts";

import type { Config } from "./config.ts";
import { DEFAULT_SHADCN_COMPONENTS, SHADCN_COMPONENTS, validateProjectName } from "./config.ts";
import { unwrap } from "./helpers.ts";

export async function promptConfig(): Promise<Config> {
  const projectName = unwrap(
    await text({
      message: "Project name",
      placeholder: "my-app",
      validate: (value) => validateProjectName(value ?? ""),
    }),
  );

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
    await confirm({ message: "Add an app workflow at the workspace root?", initialValue: true }),
  );

  return {
    projectName,
    shadcn: useShadcn,
    shadcnComponents,
    hono: useHono,
    themes: useThemes,
    testing: useTesting,
    ci: useCi,
  };
}

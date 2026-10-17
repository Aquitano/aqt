import { confirm, text } from "@clack/prompts";

import type { Config } from "./config.ts";
import { validateProjectName } from "./config.ts";
import { unwrap } from "./helpers.ts";

export async function promptConfig(): Promise<Config> {
  const projectName = unwrap(
    await text({
      message: "Project name",
      placeholder: "my-app",
      validate: (value) => validateProjectName(value ?? ""),
    }),
  );

  const useHono = unwrap(
    await confirm({ message: "Add Hono.js API backend?", initialValue: true }),
  );

  const useTesting = unwrap(
    await confirm({ message: "Add testing (Vitest + Testing Library)?", initialValue: true }),
  );

  const useCi = unwrap(
    await confirm({ message: "Add an app workflow at the workspace root?", initialValue: true }),
  );

  return {
    projectName,
    hono: useHono,
    testing: useTesting,
    ci: useCi,
  };
}

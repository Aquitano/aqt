export interface Config {
  projectName: string;
  ui: boolean;
  hono: boolean;
  /** `@aqt/ui`'s theme provider and toggle; only applies with `ui`. */
  themes: boolean;
  /** Vitest + Testing Library setup with a sample test. */
  testing: boolean;
  /** GitHub Actions CI workflow. */
  ci: boolean;
}

export function validateProjectName(value: string): string | undefined {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) {
    return "Use a lowercase app name with letters, numbers, and single hyphens, starting with a letter.";
  }
  return undefined;
}

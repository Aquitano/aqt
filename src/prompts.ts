import { confirm, multiselect, select, text } from '@clack/prompts';
import type { Config, PrettierPreset } from './config.ts';
import { DEFAULT_SHADCN_COMPONENTS, SHADCN_COMPONENTS } from './config.ts';
import { unwrap } from './helpers.ts';

export async function promptConfig(): Promise<Config> {
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

// ── Prettier presets ──────────────────────────────────────────────

export const PRETTIER_PRESETS = {
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

export type PrettierPreset = keyof typeof PRETTIER_PRESETS;

// ── shadcn/ui component catalog ──────────────────────────────────

export const SHADCN_COMPONENTS = [
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

export const DEFAULT_SHADCN_COMPONENTS = ['button', 'input', 'label', 'card', 'separator'];

/**
 * Components the generated landing page imports. When shadcn is enabled these
 * are force-installed (unioned with the user's selection) so the landing page
 * always compiles, regardless of which components were ticked.
 */
export const REQUIRED_LANDING_COMPONENTS = ['button', 'card', 'badge', 'separator'];

// ── Config type ──────────────────────────────────────────────────

export interface Config {
  projectName: string;
  eslint: boolean;
  prettier: boolean;
  prettierPreset: PrettierPreset;
  shadcn: boolean;
  shadcnComponents: string[];
  hono: boolean;
  /** next-themes dark/light mode with a toggle. */
  themes: boolean;
  /** Vitest + Testing Library setup with a sample test. */
  testing: boolean;
  /** GitHub Actions CI workflow. */
  ci: boolean;
}

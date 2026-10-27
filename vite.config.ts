import { defineConfig } from "vite-plus";
import type { DummyRule, DummyRuleMap } from "vite-plus/lint";

const ignorePatterns = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/*.gen.ts",
  "**/worker-configuration.d.ts",
  "**/drizzle/**",
  ".claude/**",
  "tools/oxlint/anti-slop/**",
  "**/generated/**",
  "**/.next/**",
  "**/.wrangler/**",
  "**/.output/**",
  "apps/gallery/packages/db/src/migrations/**",
];

const rules = {
  "typescript/no-explicit-any": "error",
  "typescript/no-unsafe-assignment": "warn",
  "typescript/no-unsafe-member-access": "warn",
  "typescript/no-unsafe-call": "warn",
  "typescript/no-unsafe-return": "warn",
  "typescript/no-unsafe-argument": "warn",
  "typescript/no-non-null-assertion": "warn",
  "typescript/no-misused-promises": ["warn", { checksVoidReturn: { attributes: false } }],
  "typescript/await-thenable": "warn",
  "typescript/switch-exhaustiveness-check": "warn",
  "typescript/only-throw-error": [
    "warn",
    {
      allow: [
        { from: "lib", name: "Response" },
        { from: "package", name: ["Redirect", "NotFoundError"], package: "@tanstack/router-core" },
      ],
    },
  ],
  "typescript/use-unknown-in-catch-callback-variable": "warn",
  "anti-slop/no-chained-type-assertions": "error",
  "anti-slop/no-conditional-empty-object-spread": "warn",
  "anti-slop/no-em-dash-copy": "warn",
  "anti-slop/no-known-value-widening": "warn",
  "anti-slop/no-low-value-comments": "warn",
  "anti-slop/no-module-mocking": "warn",
  "anti-slop/no-object-parameters": "warn",
  "anti-slop/no-reflect-apply": "warn",
  "anti-slop/no-reflect-get": "warn",
  "anti-slop/no-runtime-typeof": "off",
  "anti-slop/no-shape-in-symbol-names": "warn",
  "anti-slop/no-unknown-parameters": "warn",
  "anti-slop/no-unknown-returns": "warn",
  "anti-slop/no-unknown-type-aliases": "warn",
  "anti-slop/no-unsafe-dictionary-type": "warn",
  "anti-slop/no-widen-then-assert": "error",
  "anti-slop/require-safety-comment-for-type-assertion": "warn",
  "anti-slop/require-suppression-reason": "error",
  "react/react-in-jsx-scope": "off",
  "react/set-state-in-effect": "warn",
  "react/refs": "warn",
  "react/purity": "warn",
  "react/immutability": "warn",
  "react-hooks/exhaustive-deps": "warn",
  "unicorn/no-useless-spread": "warn",
  "unicorn/no-useless-fallback-in-spread": "warn",
  "no-useless-escape": "warn",
  "no-param-reassign": "warn",
  "typescript/prefer-as-const": "warn",
  "default-param-last": "warn",
  "typescript/prefer-enum-initializers": "warn",
  "react/self-closing-comp": "warn",
  "one-var": ["warn", "never"],
  "typescript/no-inferrable-types": "warn",
  "no-else-return": "warn",
  "no-underscore-dangle": ["warn", { allow: ["_tag"] }],
  "unicorn/prefer-number-properties": "warn",
  "vite-plus/prefer-vite-plus-imports": "error",
} satisfies DummyRuleMap;

function strict(setting: DummyRule): DummyRule {
  if (setting === "warn") return "error";
  if (Array.isArray(setting) && setting[0] === "warn") return ["error", ...setting.slice(1)];
  return setting;
}

const strictRules = Object.fromEntries(
  Object.entries(rules).map(([name, setting]) => [name, strict(setting)]),
);

const tailwindFunctions = ["cn", "cva", "clsx"];

const tailwindStylesheets = {
  "apps/bank/**": "apps/bank/internal/webui/app/src/index.css",
  "apps/gallery/**": "apps/gallery/packages/ui/src/styles/globals.css",
  "apps/img/**": "apps/img/src/styles.css",
  "apps/turnstash/**": "apps/turnstash/apps/web/src/app.css",
  "packages/ts/ui/**": "packages/ts/ui/src/styles/globals.css",
};

export default defineConfig({
  lint: {
    plugins: ["typescript", "react", "import", "unicorn", "promise", "oxc"],
    categories: {
      correctness: "error",
      suspicious: "warn",
      perf: "warn",
    },
    ignorePatterns,
    jsPlugins: [
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      "@shadcn/lint",
    ],
    settings: {
      shadcn: {
        ui: ["@aqt/ui/components", "@/components/ui"],
        themeImports: ["^@aqt/ui/"],
      },
    },
    rules,
    overrides: [
      {
        files: ["apps/img/scripts/**"],
        rules: {
          "typescript/no-non-null-assertion": "off",
          "no-await-in-loop": "off",
        },
      },
      {
        files: ["apps/gallery/packages/db/src/scripts/**"],
        rules: {
          "typescript/no-explicit-any": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-member-access": "off",
          "typescript/no-unsafe-return": "off",
          "no-await-in-loop": "off",
        },
      },
      {
        files: ["packages/ts/**"],
        rules: {
          ...strictRules,
          "typescript/only-throw-error": ["error", { allow: [{ from: "lib", name: "Response" }] }],
          "typescript/no-unnecessary-condition": "warn",
          "anti-slop/no-low-value-comments": "warn",
          "no-underscore-dangle": ["warn", { allow: ["_tag"] }],
          "typescript/no-floating-promises": "error",
        },
      },
      {
        files: ["apps/bank/**"],
        rules: {
          ...strictRules,
          "anti-slop/no-em-dash-copy": "warn",
          "anti-slop/no-low-value-comments": "warn",
        },
      },
      {
        files: [
          "apps/bank/internal/webui/app/src/**",
          "apps/gallery/apps/web/src/**",
          "apps/img/src/**",
          "apps/turnstash/apps/web/src/**",
          "packages/ts/ui/**",
        ],
        rules: {
          "anti-slop/no-hookless-use-function": "warn",
          "shadcn/no-unknown-classes": "warn",
          "shadcn/require-static-classes": "warn",
        },
      },
      {
        files: ["packages/ts/ui/src/components/**"],
        rules: {
          "shadcn/require-static-classes": "off",
        },
      },
      {
        files: ["apps/turnstash/**"],
        jsPlugins: [
          { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
        ],
        rules: {
          "no-control-regex": "off",
          "oxc/no-accumulating-spread": "error",
          "anti-slop/no-conditional-empty-object-spread": "off",
          "anti-slop/no-known-value-widening": "off",
          "anti-slop/no-module-mocking": "error",
          "anti-slop/no-object-parameters": "error",
          "anti-slop/no-reflect-apply": "error",
          "anti-slop/no-reflect-get": "error",
          "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
          "anti-slop/no-shape-in-symbol-names": "off",
          "anti-slop/no-unknown-parameters": "error",
          "anti-slop/no-unknown-returns": "error",
          "anti-slop/no-unknown-type-aliases": "error",
          "anti-slop/no-unsafe-dictionary-type": "error",
          "anti-slop/require-safety-comment-for-type-assertion": "error",
          "anti-slop-effect/no-inline-schema-compile": "warn",
          "anti-slop-effect/no-manual-effect-error-tag": "error",
          "anti-slop-effect/no-manual-tag-comparison": "error",
          "anti-slop-effect/no-manual-tagged-construction": "error",
          "anti-slop-effect/no-service-constructor-imports": "error",
          "anti-slop-effect/prefer-effect-match": "error",
        },
      },
      {
        files: ["apps/turnstash/packages/providers/src/**"],
        rules: {
          "anti-slop/no-runtime-typeof": "off",
          "anti-slop/no-unsafe-dictionary-type": "off",
        },
      },
      {
        files: ["apps/turnstash/**/test/**"],
        rules: {
          "anti-slop/no-unknown-parameters": "off",
          "anti-slop/no-unsafe-dictionary-type": "off",
          "anti-slop/no-runtime-typeof": "off",
          "anti-slop/no-reflect-get": "off",
        },
      },
      {
        files: ["**/*.test.ts", "**/*.test.tsx"],
        rules: {
          "typescript/no-non-null-assertion": "off",
        },
      },
    ],
    options: {
      reportUnusedDisableDirectives: "error",
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    printWidth: 100,
    singleQuote: false,
    semi: true,
    ignorePatterns: [
      ...ignorePatterns,
      "apps/tracker/**/testdata/**",
      "apps/turnstash/packages/pricing/data/**",
      ".swiftlint-baseline.json",
    ],
    sortImports: true,
    sortPackageJson: true,
    sortTailwindcss: { functions: tailwindFunctions },
    overrides: Object.entries(tailwindStylesheets).map(([files, stylesheet]) => ({
      files: [files],
      options: { sortTailwindcss: { functions: tailwindFunctions, stylesheet } },
    })),
  },
  test: {
    projects: [
      "apps/bank/internal/webui/app/vite.config.ts",
      "apps/gallery/vite.config.ts",
      "apps/tracker/extension/vite.config.ts",
      "apps/turnstash/vite.config.ts",
    ],
  },
});

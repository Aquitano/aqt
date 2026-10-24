# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), installed through the
`install-anti-slop` skill in [Aquitano/.dotfiles](https://github.com/Aquitano/.dotfiles)
(`common/agents/skills/install-anti-slop/assets/anti-slop`). Update this copy with that skill; it
reads this file to tell upstream changes from local ones.

## Base

- Generic plugin (`index.ts`, `rules/`, `shared/`): the skill at dotfiles commit
  `4db8f7e1a8cedef60612fbfd912b14a8e9abc145`. All 19 files were byte-identical when `52e79b2e`
  added them. That commit does not record which anti-slop revision it vendored.
- Effect plugin (`effect/`): the skill at dotfiles commit
  `f535ee97ff66167199cd11d28d2b957130271a76`, which pins anti-slop
  `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`. It came from Turnstash's vendored copy when
  Turnstash joined the workspace in `95a93021`.

## Local changes

- `rules/require-suppression-reason.ts` adapts
  [T3 Code's rule at `4812dca`](https://github.com/pingdotgg/t3code/blob/4812dcad02a86874533540e6a0c4b7f5eaea297a/oxlint-plugin-t3code/rules/require-suppression-reason.ts).
  Its MIT license is preserved in `LICENSE.t3code`. Lint disables and TypeScript suppressions need
  an inline explanation or an adjacent explanatory comment. This rule and unused-disable reporting
  are errors. Tailwind validation comes from the separate `@shadcn/lint` package and starts as
  warnings in React source directories.
- `rules/no-hookless-use-function.ts`, `rules/no-low-value-comments.ts`, and
  `effect/rules/no-inline-schema-compile.ts` adapt
  [T3 Code's rules at `4812dca`](https://github.com/pingdotgg/t3code/tree/4812dcad02a86874533540e6a0c4b7f5eaea297a/oxlint-plugin-t3code/rules).
  Their MIT license is preserved in `LICENSE.t3code`. They use typed Oxlint nodes without new
  dependencies. The hook check tracks nested functions separately and runs in React source
  directories. The schema check runs in Turnstash, resolves Effect Schema imports, and leaves
  compilers that reference function-local bindings alone. The comments check preserves directives
  and `SAFETY:` comments and does not require issue links for TODO markers. All three start as
  warnings, including the comments check in shared packages. The upstream baseline above is unchanged.
- `rules/no-em-dash-copy.ts` is a local addition inspired by
  [T3 Code's rule at `4812dca`](https://github.com/pingdotgg/t3code/blob/4812dcad02a86874533540e6a0c4b7f5eaea297a/oxlint-plugin-t3code/rules/no-em-dash-copy.ts).
  It checks string literals, template text, and JSX text for U+2014. The workspace enables it as a
  warning, with the existing shared-package override raising it to an error. It does not check
  comments or other file formats. The upstream baseline above is unchanged.
- Imports come from `vite-plus/lint/plugins` instead of `@oxlint/plugins`. Vite+ bundles oxlint, and
  under Bun's isolated linker `@oxlint/plugins` resolves only from inside `vite-plus`.
- `rules/no-unknown-parameters.ts` exempts the function that is itself the boundary: a type
  predicate, or a body that inspects the value with `typeof`, `instanceof`, `in`, `Array.isArray`,
  `JSON.stringify` or `String` (`726dbcce`).
- `rules/no-module-mocking.ts` also recognizes `vi` from `vite-plus/test` and Bun's `mock.module`
  from `bun:test`. The dotfiles skill carries the same change.
- `shared/dictionary-types.ts` reads the first intersection member through destructuring, so the
  plugin type-checks under the root `tsconfig.json` and its `noUncheckedIndexedAccess`.
- Turnstash's copy also had `no-array-filter-map` and `no-reduce-accumulator-copy`. They were
  dropped when Turnstash moved in.

## Not merged

The generic plugin has not taken the skill's changes after `4db8f7e`, which include
`no-array-filter-map`, `no-reduce-accumulator-copy`, and `require-readable-spacing` with its vendored
ESLint Stylistic rule. Merge them three-way against `4db8f7e`.

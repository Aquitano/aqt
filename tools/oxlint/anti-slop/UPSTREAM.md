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

# Vendored anti-slop Oxlint plugin

Source: the `install-anti-slop` skill bundle (`~/.claude/skills/install-anti-slop/assets/anti-slop`, SKILL.md dated 2026-09-19). The bundle records no upstream repository or commit, so the source revision is unknown. Installed 2026-09-22 with `node <skill>/scripts/install.mjs`, unmodified.

Tree digest at install (sha256 over sorted per-file sha256 sums, first 16 hex, excluding this file): `44a6f958c61f71d0`

Installed entry points:

- `tools/oxlint/anti-slop/index.ts` (plugin name `anti-slop`)
- `tools/oxlint/anti-slop/effect/index.ts` (plugin name `anti-slop-effect`)

Pinned dependencies: `oxlint` and `@oxlint/plugins` at the same exact version in the root `package.json`. Upgrade both together.

The nested `vendor/eslint-stylistic/` directory keeps its own `LICENSE` and `UPSTREAM.md`.

## Deviations from the recommended configuration

Rules disabled in `.oxlintrc.json` because they conflict with deliberate idioms in this repository:

- `require-readable-spacing`: the codebase groups short top-level declarations and uses guard-clause `if`/`return` without blank lines. Enabling it would rewrite about 1,900 sites of whitespace.
- `no-conditional-empty-object-spread`: `exactOptionalPropertyTypes` is on, so `...(x === undefined ? {} : { x })` is the standard way to omit optional keys.
- `no-known-value-widening`: lookup tables are annotated `Readonly<Record<string, string>>` on purpose so they can be indexed by arbitrary keys under `noUncheckedIndexedAccess`.
- `no-shape-in-symbol-names`: Effect's `Context.Service<Self, Shape>` convention names service interfaces `*Shape`.

Overrides:

- `packages/providers/src/**` is the I/O boundary that parses third-party JSONL, so `no-runtime-typeof`, `no-unsafe-dictionary-type` and `no-unknown-parameters` are off there.
- `**/test/**` may build loose fixtures and Proxy doubles, so `no-unknown-parameters`, `no-unsafe-dictionary-type`, `no-runtime-typeof` and `no-reflect-get` are off there.

`no-runtime-typeof` runs with `allowInTypeGuards: true`. The native `no-control-regex` rule is off because the transcript scrubbers match control characters on purpose.

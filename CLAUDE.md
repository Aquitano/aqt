# aqt

Personal software workspace. Each directory under `apps/` is an independent product with its own build; read its README, and its AGENTS.md where one exists, before working in it. Apps never import each other. Shared code lives under `packages/<language>/` and is created only when two apps need it.

## Tooling

- mise pins every toolchain, including swiftformat, swiftlint, xcodegen and golangci-lint (`mise install`, then `mise exec --` or shell activation). Root `bun install` covers every TypeScript project.
- `mise run <app>:check` and `mise run <app>:dev` are the entry points for every app, `mise run <app>:deploy` for the ones on the VPS; `mise tasks` lists them. They are thin wrappers over the native commands below, defined in the root `mise.toml` and included `tools/tasks/*.toml`. Root `check` discovers `*:check`; `ts:check` discovers `*:ts`, including existing TS tests. App checks depend on their scoped TS task and `shared:ts`, which mise runs once per invocation. Native Go tasks have no TS dependency. New stack apps register their own task fragment automatically. mise flags go before the task name (`mise run -n check`); anything after it is passed to the task.
- TypeScript: `bun run lint`, `bun run fmt`, `bun run typecheck` from the root. Every TypeScript package has a `typecheck` script; the root one runs them all through `bun run --filter`. From inside an app run `oxlint --type-aware` and `oxfmt` directly; they find the root config from anywhere. Nested `.oxlintrc.json` files only hold overrides. anti-slop, type-aware `typescript/*` and legacy React rules are warnings in apps and errors in `packages/`; fix them in files you touch. Decode `unknown` at the boundary (ArkType) instead of asserting or widening past a rule.
- Go: `go build ./...`, `go test -race ./...`, `golangci-lint run` inside the app.
- Swift: `swiftformat .` and `swiftlint` from the root; build with `apps/<app>/run.sh`.

## Conventions

- Conventional Commits with the app as scope: `feat(notch): ...`, `chore(bank): ...`.
- New TypeScript packages and apps: Base UI for components, ArkType for validation, `cn` from the `cn` package, React Compiler on, tsconfig extends `@aqt/config`. Existing apps keep their test runner and stack until touched.
- New Swift tests use swift-testing.
- Commit to main directly for now.
- Workspace decisions made during the migration are in `docs/adr/`, to be removed once the migration is done. App-level ADRs under `apps/*/docs/adr` stay with their app.

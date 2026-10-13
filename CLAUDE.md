# aqt

Personal software workspace. Each directory under `apps/` is an independent product with its own build; read its README, and its AGENTS.md where one exists, before working in it. Apps never import each other. Shared code lives under `packages/<language>/` and is created only when two apps need it.

## Tooling

- mise pins every toolchain, including swiftformat, swiftlint, xcodegen and golangci-lint (`mise install`, then `mise exec --` or shell activation). Root `bun install` covers every TypeScript project.
- `mise run <app>:check` and `mise run <app>:dev` are the entry points for every app, `mise run <app>:deploy` for the ones on the VPS; `mise tasks` lists them. They are thin wrappers over the native commands below, defined in the root `mise.toml` and included `tools/tasks/*.toml`. Root `check` discovers `*:check`; `ts:check` discovers `*:ts`, including existing TS tests. App checks depend on their scoped TS task and `shared:ts`, which mise runs once per invocation. Native Go tasks have no TS dependency; Go apps that build against `packages/go` depend on `shared:go` instead. New stack apps register their own task fragment automatically. mise flags go before the task name (`mise run -n check`); anything after it is passed to the task.
- TypeScript: `bun run lint`, `bun run fmt`, `bun run typecheck` from the root. Every TypeScript package has a `typecheck` script; the root one runs them all through `bun run --filter`. From inside an app run `oxlint --type-aware` and `oxfmt` directly; they find the root config from anywhere. Nested `.oxlintrc.json` files only hold overrides. Lint severity and scoped exceptions live in `.oxlintrc.json`; fix reported warnings in files you touch. Decode `unknown` at the boundary (ArkType) instead of asserting or widening past a rule.
- Go: `go build ./...`, `go test -race ./...`, `golangci-lint run` inside the app.
- Swift: `swiftformat .` and `swiftlint` from the root; build with `apps/<app>/run.sh`.

## Conventions

- Use exact-text edits or patches for source containing regexes, Unicode escapes, SQL or multiline literals. Inspect the resulting literal and run its focused test.
- Conventional Commits with the app as scope: `feat(notch): ...`, `chore(bank): ...`.
- New TypeScript packages and apps: Base UI for components, ArkType for validation, `cn` from the `cn` package, React Compiler on, tsconfig extends `@aqt/config`. Existing apps keep their test runner and stack until touched.
- New Swift tests use swift-testing.
- Commit to main directly for now.
- App-level ADRs stay under `apps/*/docs/adr`. The initial workspace migration is complete.
- Keep native builds behind mise tasks. Do not add Nx, Turbo or another workspace orchestrator.
- Shared packages have a concrete purpose and at least two consumers; do not create catch-all `utils` or `core` packages. Workspace consumers use the checked-out package; external consumers use tagged versions.
- Web apps use the components and theme from `@aqt/ui`; app-specific styling stays with the app. New components follow shadcn Base UI base-maia. Each app can set `--brand`; use the shared ThemeProvider and chart components.
- Turnstash keeps Effect v4 and Effect Schema. Other new validation uses ArkType. Keep the Effect packages at the same stable version in the root catalog.
- TypeScript keeps the app's existing test runner. Fix lint warnings in touched files and promote rules per app when it is clean. Keep shared package lint strict.
- Swift dependencies in XcodeGen manifests are exact versions or audited revisions. SwiftLint's baseline excludes existing findings; new findings fail CI. Keep swiftformat's keypath rule disabled because it breaks Starboard type inference.
- CI installs tool versions from mise and calls the same scoped tasks used locally. Install only the tools that each job needs.
- VPS compose files stay beside their app; `ops/` holds deploy and secrets scripts. Private services use Tailscale, public web apps use Clerk.
- Notch releases use `notch/v*`; turnstash releases use `turnstash/v*` and must never become the repository's latest release, because Notch's update feed follows it.
- Preserve `packages/ts/ui` and workspace configuration when importing further changes from a former standalone repository. Nothing automatically reconciles those repositories.

# aqt

Personal software workspace. Each directory under `apps/` is an independent product with its own build; read its README before working in it. Apps never import each other. Shared code lives under `packages/<language>/` and is created only when two apps need it.

## Tooling

- mise pins toolchains (`mise install`). Root `bun install` covers every TypeScript project.
- TypeScript: `bun run lint`, `bun run fmt`, `bun run typecheck` from the root. From inside an app run `oxlint` and `oxfmt` directly; they find the root config from anywhere. Nested `.oxlintrc.json` files only hold overrides. anti-slop rules are errors in `packages/` and warnings in apps; fix them in files you touch.
- Go: `go build ./...`, `go test -race ./...`, `golangci-lint run` inside the app.
- Kotlin: `./gradlew check` (needs Docker or `AQT_HEALTH_TEST_JDBC_URL`), `./gradlew ktlintFormat` inside `apps/health`. `apps/health/frontend` is part of health, not a separate product.
- Swift: `swiftformat .` and `swiftlint` from the root; build with `apps/<app>/run.sh`.

## Conventions

- Conventional Commits with the app as scope: `feat(notch): ...`, `chore(bank): ...`.
- New TypeScript packages and apps: Base UI for components, ArkType for validation, `cn` from the `cn` package, React Compiler on, tsconfig extends `@aqt/config`. Existing apps keep their test runner and stack until touched.
- New Swift tests use swift-testing.
- Commit to main directly for now.
- Workspace decisions made during the migration are in `docs/adr/`, to be removed once the migration is done. App-level ADRs under `apps/*/docs/adr` stay with their app.

# aqt

Personal software workspace. Each directory under `apps/` is an independent product with its own build; read its README before working in it. Apps never import each other. Shared code lives under `packages/<language>/` and is created only when two apps need it.

Root tooling: mise pins toolchains, oxlint and oxfmt cover TypeScript, golangci-lint covers Go, swiftformat and swiftlint cover Swift, ktlint covers Kotlin. Run `bun run lint` and `bun run fmt:check` before committing TypeScript.

Decisions are recorded in `docs/adr/`.

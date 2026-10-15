# aqt

Personal software workspace: the things I build for myself, in one repository.

Health is maintained in [Aquitano/aqt-health](https://github.com/Aquitano/aqt-health). Its former monorepo directory contains a redirect.

Every active app under `apps/` is a self-contained project with its own native build. The root only adds toolchain pins, lint and format configuration, shared packages, and ops.

| Path                   | What                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `apps/`                | Products, one directory each, each with its own build system                                  |
| `packages/<language>/` | Shared code, created only when two apps need it. Go extraction and shared TypeScript packages |
| `ops/`                 | Deploy and secrets scripts for VPS services                                                   |
| `tools/`               | Development tooling, including the lint plugin                                                |

## Setup

```sh
brew install mise
mise install
bun install
```

mise pins Node.js, Bun, Go, golangci-lint, swiftformat, swiftlint and xcodegen. Activate it in your shell (`mise activate`) or prefix commands with `mise exec --`.

## Checks

```sh
mise tasks            # list every entry point
mise run <app>:check  # one app's lint, typecheck and tests, with its native tools
mise run <app>:dev    # run one app locally
mise run ts:check     # TypeScript only, including existing tests
mise run check        # everything
```

Each task wraps the app's own tooling (`go test`, `bun run`, `xcodebuild`). TypeScript app checks include lint, formatting, types, and existing tests, plus checks of shared TypeScript packages. mise runs each shared task once per invocation. Go checks can run alongside TypeScript checks.

Tasks live in `mise.toml` and `tools/tasks/*.toml`. The stack generator registers each new app there after its checks and build pass. Root `check` discovers `*:check` tasks, and `ts:check` discovers `*:ts` tasks, so new apps join both aggregates automatically. `workspace:check` covers formatting outside app and shared-package tasks.

Put mise flags before the task name, for example `mise run -n check` to preview the graph. App-specific scripts remain available inside each app.

Vite+ owns the TypeScript toolchain. The root `vite.config.ts` contains shared
lint and format settings, package-specific rule overrides, and the Vitest projects.
App Vite configs keep their framework plugins, proxies, and build settings. The
root Bun catalog pins Vite+ and its Vite alias together.

```sh
bun run check       # formatting, type-aware lint and TypeScript diagnostics
bun run typecheck   # explicit package checks, including project references
bun run test        # portable suites through Vitest
```

Bank's frontend, Tracker's extension, Gallery's layout and renderer, and
Turnstash's web, API-schema and analysis tests use Vitest. Gallery's server,
Turnstash's Bun runtime packages and server, and the stack generator keep Bun tests.
Their app checks run both runners where needed. Bank also rebuilds and checks its
committed embedded UI assets. Turbo still coordinates Gallery's package tasks.

## Dependency updates

Dependabot covers Bun, Go modules, Dockerfiles, Compose images and GitHub Actions.
Tooling updates are separate from application dependencies. Check catalog entries with
`bun outdated` after each update and keep related Effect packages on one version.
The weekly `swift-dependencies` workflow checks version-tagged Swift dependencies
in XcodeGen `project.yml` files. It skips dependencies pinned to audited Git revisions,
which require manual review. Dependabot does not read XcodeGen manifests.

Database images share the same ParadeDB extension version. Keep each deployment's
PostgreSQL major unchanged when updating an image: turnstash uses 17, and bank,
attic and tracker use 18. Changing the major needs a separate data migration.

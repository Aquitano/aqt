# aqt

Personal software workspace: the things I build for myself, in one repository.

Every app under `apps/` is a self-contained project with its own native build. The root only adds toolchain pins, lint and format configuration, shared packages, and ops.

| Path                   | What                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| `apps/`                | Products, one directory each, each with its own build system                     |
| `packages/<language>/` | Shared code, created only when two apps need it. Today only `packages/ts` exists |
| `ops/`                 | Compose files and the deploy script for the VPS services                         |
| `tools/`               | Development tooling, including the lint plugin                                   |
| `docs/adr/`            | Decisions                                                                        |

## Setup

```sh
brew install mise
mise install
bun install
```

mise pins bun, go, java, golangci-lint, swiftformat, swiftlint and xcodegen. Activate it in your shell (`mise activate`) or prefix commands with `mise exec --`.

## Checks

```sh
mise tasks            # list every entry point
mise run <app>:check  # one app's lint, typecheck and tests, with its native tools
mise run <app>:dev    # run one app locally
mise run ts:check     # TypeScript only, including existing tests
mise run check        # everything
```

Each task wraps the app's own tooling (`go test`, `./gradlew check`, `turbo`, `xcodebuild`). TypeScript app checks include lint, formatting, types, and existing tests, plus checks of shared TypeScript packages. mise runs each shared task once per invocation. Go and Kotlin checks can run alongside TypeScript checks; `health:check` needs Docker or `AQT_HEALTH_TEST_JDBC_URL`.

Tasks live in `mise.toml` and `tools/tasks/*.toml`. The stack generator registers each new app there after its checks and build pass. Root `check` discovers `*:check` tasks, and `ts:check` discovers `*:ts` tasks, so new apps join both aggregates automatically. `workspace:check` covers formatting outside app and shared-package tasks. Gallery keeps its scoped Turbo typechecks and cache.

Put mise flags before the task name, for example `mise run -n check` to preview the graph. App-specific scripts remain available inside each app.

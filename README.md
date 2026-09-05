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
brew install mise swiftformat swiftlint xcodegen
mise install
bun install
```

## Checks

```sh
bun run lint
bun run fmt:check
```

Each app's own tests run from its directory with its native tool: `go test ./...`, `./gradlew check` (needs Docker or `AQT_HEALTH_TEST_JDBC_URL`), `bun run test`, `make test`.

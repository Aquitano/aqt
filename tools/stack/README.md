# aqt-stack

Create a Next.js app inside this workspace:

```sh
bun run tools/stack/index.ts
```

The generator resolves the workspace from its own location, so the destination is
always `apps/<name>`, even when invoked from another directory. Names are lowercase
letters and numbers separated by hyphens. Existing app directories and workflow
files and mise task fragments are never overwritten. Existing mise task names and
aliases reserve their app namespace, including tasks from other fragments.

Every app gets:

- A private `@aqt/<name>` package using the root Bun workspace and lockfile.
- TypeScript extending `@aqt/config/tsconfig.base.json`, with the root compiler version.
- Oxlint and Oxfmt from the workspace, with Next.js lint rules added locally.
- React Compiler, Tailwind CSS, and ArkType environment validation through T3 Env.
- `dev`, `build`, `start`, `lint`, `fmt`, `fmt:check`, `typecheck`, and `check` scripts.
- `mise run <name>:check` and `mise run <name>:dev` entry points, registered in
  `tools/tasks/<name>.toml`. App checks also run shared TypeScript checks.
  Root `check` and `ts:check` discover the app automatically, including optional tests.

Optional features:

- Components, tokens, fonts and themes from the shared `@aqt/ui` package.
  App-specific blocks can use shadcn while reusing those components.
- Hono routes with ArkType request validation and a typed RPC client. The sample
  users API uses an unauthenticated in-memory store; replace it before deployment.
- A theme provider and dark-mode toggle.
- Vitest and Testing Library, including a page test and an API health test.
- `.github/workflows/<name>.yml` at the repository root. It runs app checks and a
  production build when the app or shared tooling changes, using Bun from mise.

The generator installs dependencies, formats the app, runs its checks and builds
it before registering its mise tasks and validating task dispatch. It neither
initializes Git nor stages or commits files. Review the new app, task fragment,
root lockfile, and optional workflow together.

If a command fails, the partial app remains available for inspection. Fix it in
place or remove that newly generated app, its task fragment if present, and its
workflow before retrying. Task registration happens after app validation, so an
earlier failure leaves the app outside mise aggregates. The root Bun typecheck
script discovers workspace packages automatically. The generator requires the
root mise includes and wildcard aggregate dependencies to be configured.

## Maintenance

```sh
bun run --filter @aqt/stack test
bunx --no-install tsc --noEmit -p tools/stack
bunx --no-install oxlint --type-aware tools/stack
```

The CLI versions live in `src/pipeline.ts`. When updating them, generate an app in
a temporary copy of the workspace with all options enabled, then check and build
it. Also test the minimal app without optional features. The unit tests cover
option combinations, destination protection, and workspace integration; they do
not download the upstream generators. When mise is installed, an integration test
executes the real task graph in a temporary workspace with marker commands. It
checks app discovery, shared-task deduplication, app directories, and native checks
without TypeScript dependencies.

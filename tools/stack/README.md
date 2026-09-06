# aqt-stack

Create a Next.js app inside this workspace:

```sh
bun run tools/stack/index.ts
```

The generator resolves the workspace from its own location, so the destination is
always `apps/<name>`, even when invoked from another directory. Names are lowercase
letters and numbers separated by hyphens. Existing app directories and workflow
files are never overwritten.

Every app gets:

- A private `@aqt/<name>` package using the root Bun workspace and lockfile.
- TypeScript extending `@aqt/config/tsconfig.base.json`, with the root compiler version.
- Oxlint and Oxfmt from the workspace, with Next.js lint rules added locally.
- React Compiler, Tailwind CSS, and ArkType environment validation through T3 Env.
- `dev`, `build`, `start`, `lint`, `fmt`, `fmt:check`, `typecheck`, and `check` scripts.

Optional features:

- shadcn components built on Base UI, with `cn` for class names. Components stay in
  the app until another app needs them.
- Hono routes with ArkType request validation and a typed RPC client. The sample
  users API uses an unauthenticated in-memory store; replace it before deployment.
- A theme provider and dark-mode toggle.
- Vitest and Testing Library, including a page test and an API health test.
- `.github/workflows/<name>.yml` at the repository root. It runs app checks and a
  production build when the app or shared tooling changes, using Bun from mise.

The generator installs dependencies, formats the app, runs its checks and builds
it before reporting success. It neither initializes Git nor stages or commits
files. Review the new app, root lockfile, and optional workflow together.

If a command fails, the partial app remains available for inspection. Fix it in
place or remove that newly generated app and its workflow before retrying. The
root TypeScript script currently lists existing apps explicitly; the generated
app's `check` script and optional workflow cover its types independently.

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
not download the upstream generators.

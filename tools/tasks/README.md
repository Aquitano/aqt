# App tasks

The root mise.toml includes task files from this directory. The stack generator
writes one `<app>.toml` file for each new app. These files use mise's included-task
format, so sections are `["<app>:check"]`, without a `tasks.` prefix.

- `<app>:check` depends on `<app>:ts` and `shared:ts`.
- `<app>:ts` runs the app's lint, format check, typecheck and optional tests.
- `<app>:dev` starts the development server.
- `<app>:deploy`, for an app that runs on the VPS, calls `ops/deploy.sh` with
  that app's checkout path there.

The root `check` depends on `*:check`, and `ts:check` depends on `*:ts`. Adding an
app file therefore registers both its standalone commands and aggregate checks.
Each shared dependency runs once per mise invocation.

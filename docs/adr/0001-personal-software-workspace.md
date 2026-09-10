# 0001: One workspace for personal software

Date: 2026-09-05

## Context

Eight repositories (aqt-bank, aqt-sync, aqt-health, aqt-gallery, aqt-img, aqt-stack, starboard, notch) were audited for shared code. Genuinely shareable code was 0.3% of Go, 1.4% of TypeScript and 1.7% of Swift. What was duplicated instead was decisions: Dockerfile recipes, compose hardening, run scripts, lint setups, CI, agent conventions, and a platform layer (Clerk user, image upload, API keys, MCP) built twice in gallery and img. Four repos had no CI, two services claimed port 8080, and fixes made in one repo never reached its sibling.

## Decision

One repository, `aqt`, for software built for personal use. It is a workspace, not one application.

- `apps/<name>`: each product keeps its native build and never imports another app.
- `packages/<language>/<name>`: shared code, created only once two apps need it. No `utils` or `core` package.
- `ops/`: the deploy script for VPS services, one manual script over ssh. Compose files stay next to each app's Dockerfile.
- `tools/`: development tooling. `aqt-stack` moves here and is retargeted later.
- Root: mise pins toolchains. No orchestrator (no Nx, no turbo).
- History is preserved by `git subtree add`. The repo starts private and goes public after a secrets sweep. License is AGPL-3.0.

Inside the repo, packages are consumed at HEAD. Outside repos that want a package consume a tagged version and lag on purpose.

## Scope

In: bank, health, gallery, img, starboard, notch, aqt-stack, `.docker`, `scripts`. Later, when the layout is proven: location-log, swipey, utils-page.

Out: aqt-sync (licensed product with an audience), chill-flow, aqt-aura, codeburn, powerlog, portfolio sites, and everything meant for other people. Superseded: maildex, aqt-drink, aqt-reader, homelab. Old repos stay as they are for now.

## Tooling

- TypeScript: oxlint and oxfmt, configured once at the root. Oxlint finds the root config from any app directory, so agents lint from wherever they are. Nested `.oxlintrc.json` files exist only for overrides.
  - Format: 2 spaces, double quotes, semicolons, width 100. oxfmt sorts imports, Tailwind classes (per-app stylesheet overrides for Tailwind v4) and package.json keys.
  - Lint: correctness as error, suspicious and perf as warning; plugins typescript, react, import, unicorn, promise; nextjs in health's frontend only.
  - anti-slop rules are errors in `packages/` and warnings in existing apps, fixed as files are touched. Legacy React findings (set-state-in-effect, refs, exhaustive-deps) are likewise warnings in apps.
  - Lint is type-aware everywhere (`oxlint --type-aware`, a few seconds for the whole workspace). The `no-unsafe-*` family, `no-explicit-any`, `no-non-null-assertion`, `no-unnecessary-condition`, floating and misused promises, `await-thenable`, `switch-exhaustiveness-check` and `only-throw-error` are errors in `packages/` and warnings in apps, so an `any` from `Response.json()` or a bare `!` is visible instead of silently typed.
  - Biome and eslint are removed from every app. Gallery's biome style rules are ported for every app (no-param-reassign, prefer-as-const, default-param-last, prefer-enum-initializers, self-closing-comp, one-var never, no-inferrable-types, no-else-return, prefer-number-properties); biome's unused-template-literal rule has no oxlint counterpart. Tailwind class sorting moved to oxfmt. Health's eslint-config-next is covered by oxlint's nextjs plugin.
  - `cn` from shadcn replaces clsx and tailwind-merge, starting with `@aqt/ui`; apps migrate with `shadcn migrate cn` when cleaned up.
- Go: gofmt, golangci-lint v2.
- Kotlin: ktlint via Gradle.
- Swift: swiftformat and swiftlint, configuration from starboard extended to notch.
- Editorconfig at the root.

## Stacks

Gallery (Bun, Postgres, tRPC, Base UI, zod) and img (Cloudflare Worker, D1, R2, Radix, ArkType) keep their stacks. Shared TypeScript packages are therefore limited to what is stack-free: config, theme tokens, the `cn` helper, and later MCP wrappers. New shared UI components use Base UI. New validation uses ArkType.

## Applied after the initial import (2026-09-05)

- Every tsconfig extends `@aqt/config` (base, app, bun). Apps that fail the stricter base flags carry a local override, to be removed when cleaned: img and gallery web (`noUncheckedIndexedAccess`), health frontend (`noUncheckedIndexedAccess`, unused locals and parameters).
- Packages renamed to `@aqt/*`: gallery-web, gallery-server, gallery-auth, gallery-db, gallery-env, gallery-ui, img, img-cli, health-frontend, bank-webui, stack. Path alias is `@/` everywhere.
- Bank's Go module is `github.com/aquitano/aqt/apps/bank`. CI runs the race detector.
- Health runs ktlint through the Gradle plugin, ktlint_official style, property naming disabled for build scripts.
- Starboard moved to Swift 6 language mode and automatic signing. Notch's run script gained starboard's path and Launch Services fixes.
- Workflows live at the root with path filters: bank, health, ts, notch-release (tags `notch/v*`). Dependabot at the root covers bun, Go, Gradle, Swift and actions.
- Apps that had an agent file keep it: `apps/health/AGENTS.md` and `apps/notch/AGENTS.md`, each with a one-line `CLAUDE.md` that imports it. `tools/stack` keeps its Cursor rule. Root CLAUDE.md holds workspace conventions only.
- Gallery keeps turbo. Turbo takes the workspace manifest as the repository root, so `turbo.json` lives at the root and turbo is installed there; only gallery's scripts invoke it, filtered to `@aqt/gallery-*`. Nothing else is orchestrated.
- Test runners stay as they are per app. React Compiler is on for new apps and packages only. Starboard remains a local build; only notch releases.

## Applied 2026-09-06: task entry points

- mise tasks are the discoverable entry points for every app: `mise run <app>:check`, `mise run <app>:dev`, `mise run check` for everything, `mise tasks` to list them. Each task is a short list of the app's native commands with `dir` set to the app; TypeScript steps call the package's own scripts. No caching layer, no package.json for Go or Swift apps. Swift lint tasks run from the root because the swiftlint config and baseline live there.
- Every TypeScript package has a `typecheck` script (gallery's `check-types` renamed); the root `typecheck` is `bun run --filter '*' typecheck` instead of a hand-maintained list of tsconfig paths. Bun skips packages without the script, so a new package is unchecked until it adds one.
- All tasks live in the root `mise.toml`. mise's monorepo mode (per-app `mise.toml` files addressed as `//apps/bank:check`) is the path if the block outgrows one file.
- The check workflows keep calling native tools directly for their setup-action caching and annotations; only the notch release workflow installs mise.

## Applied 2026-09-10: gallery re-import

`aqt-gallery` kept moving after the 5 September `git subtree add`, and its history was rewritten by squash merges. The split commit `62f1510` no longer exists upstream, so `git subtree pull` has no merge base. The app was re-imported as content at upstream `5d08eb4` and the workspace layer re-applied on top: `@aqt/gallery-*` package names, tsconfigs extending `@aqt/config`, oxlint and oxfmt in place of Biome, no nested CI or turbo config, the curator skill at the workspace root.

What arrived with it: exhibitions replacing galleries and museums, a React Three Fiber renderer in place of the Bevy/WASM engine (which never reached this repo), S3-compatible media storage, and `packages/gallery-layout`. Upstream's `overrides` pin of `@tanstack/query-core` moved to the root manifest, where bun reads it, and `lucide-react` joined the root catalog. The Bun suite that came with the import runs from `gallery:ts` and the `ts` workflow; upstream's render-budget harness, which drives headless Chromium through Playwright, stayed a manual script in `apps/web`.

Open: whether the standalone repository stays a development home. Nothing reconciles the two automatically, and the next divergence needs another content re-import.

## Toolchain versions (2026-09-05)

mise pins bun 1.4.2, Go 1.27.1, Temurin 25, golangci-lint 2.13.2, swiftformat 0.63.0, swiftlint 0.65.1, xcodegen 2.46.0. Node is not managed by mise; `.node-version` says 26 for fnm. Go and Java are pinned identically in go.mod, go.work, the Dockerfiles, CI and mise; bump all of them together.

swiftformat runs with the keypath rule disabled because it broke type inference in starboard. swiftlint uses a committed baseline so only new violations fail; the backlog of 264 findings burns down as files are touched. golangci-lint excludes unchecked deferred Close calls and errcheck in tests; everything else in bank is clean.

## Deferred

- Re-enable ktlint's property-naming and filename rules in health after renaming its 32 constants and 4 files, and bring max line length back to 140.
- Fix the React and anti-slop warnings in apps and promote them to errors app by app.

- Unified logging to OpenObserve: one package per server language plus a written contract, after the migration.
- Auth model as a written contract: private services behind Tailscale, public web on Clerk.
- Publishing packages for outside repos.

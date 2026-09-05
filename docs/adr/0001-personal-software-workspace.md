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
  - Type-aware rules (floating and misused promises, await-thenable, switch exhaustiveness) run on `packages/ts` only.
  - Biome and eslint are removed from every app. Turbo stays inside gallery.
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
- Per-app agent files removed; notch's lessons-learned moved to `apps/notch/docs/notes.md`. Root CLAUDE.md is the only agent file.
- Test runners stay as they are per app. React Compiler is on for new apps and packages only. Starboard remains a local build; only notch releases.

## Toolchain versions (2026-09-05)

mise pins bun 1.4.2, Go 1.27.1, Temurin 25, golangci-lint 2.13.2, swiftformat 0.63.0, swiftlint 0.65.1, xcodegen 2.46.0. Node is not managed by mise; `.node-version` says 26 for fnm. Go and Java are pinned identically in go.mod, go.work, the Dockerfiles, CI and mise; bump all of them together.

swiftformat runs with the keypath rule disabled because it broke type inference in starboard. swiftlint uses a committed baseline so only new violations fail; the backlog of 264 findings burns down as files are touched. golangci-lint excludes unchecked deferred Close calls and errcheck in tests; everything else in bank is clean.

## Deferred

- Revisit gallery's ten biome style rules (no parameter reassignment, self-closing elements, no useless else, and the rest) and port the ones worth keeping to oxlint for every app.
- Re-enable ktlint's property-naming and filename rules in health after renaming its 32 constants and 4 files, and bring max line length back to 140.
- Fix the React and anti-slop warnings in apps and promote them to errors app by app.

- Unified logging to OpenObserve: one package per server language plus a written contract, after the migration.
- Auth model as a written contract: private services behind Tailscale, public web on Clerk.
- Publishing packages for outside repos.

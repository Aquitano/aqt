# 0001: One workspace for personal software

Date: 2026-09-05

## Context

Eight repositories (aqt-bank, aqt-sync, aqt-health, aqt-gallery, aqt-img, aqt-stack, starboard, notch) were audited for shared code. Genuinely shareable code was 0.3% of Go, 1.4% of TypeScript and 1.7% of Swift. What was duplicated instead was decisions: Dockerfile recipes, compose hardening, run scripts, lint setups, CI, agent conventions, and a platform layer (Clerk user, image upload, API keys, MCP) built twice in gallery and img. Four repos had no CI, two services claimed port 8080, and fixes made in one repo never reached its sibling.

## Decision

One repository, `aqt`, for software built for personal use. It is a workspace, not one application.

- `apps/<name>`: each product keeps its native build and never imports another app.
- `packages/<language>/<name>`: shared code, created only once two apps need it. No `utils` or `core` package.
- `ops/`: compose and deploy for VPS services. Deploy is one manual script over ssh.
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

## Deferred

- Revisit gallery's ten biome style rules (no parameter reassignment, self-closing elements, no useless else, and the rest) and port the ones worth keeping to oxlint for every app.
- Fix the React and anti-slop warnings in apps and promote them to errors app by app.

- Unified logging to OpenObserve: one package per server language plus a written contract, after the migration.
- Auth model as a written contract: private services behind Tailscale, public web on Clerk.
- Publishing packages for outside repos.

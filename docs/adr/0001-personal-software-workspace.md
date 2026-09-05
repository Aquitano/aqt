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

- TypeScript: oxlint with the anti-slop plugin, oxfmt. Biome and eslint are removed from every app. Tailwind class sorting in oxfmt is verified on first use; prettier with the Tailwind plugin is the fallback.
- Go: gofmt, golangci-lint v2.
- Kotlin: ktlint via Gradle.
- Swift: swiftformat and swiftlint, configuration from starboard extended to notch.
- Editorconfig at the root.

## Stacks

Gallery (Bun, Postgres, tRPC, Base UI, zod) and img (Cloudflare Worker, D1, R2, Radix, ArkType) keep their stacks. Shared TypeScript packages are therefore limited to what is stack-free: config, theme tokens, the `cn` helper, and later MCP wrappers. New shared UI components use Base UI. New validation uses ArkType.

## Deferred

- Unified logging to OpenObserve: one package per server language plus a written contract, after the migration.
- Auth model as a written contract: private services behind Tailscale, public web on Clerk.
- Publishing packages for outside repos.

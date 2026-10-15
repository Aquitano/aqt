# aqt-gallery

A 3D virtual-museum builder. Import and archive artworks (artist, tags, custom
fields, source provenance), curate them into **exhibitions** of one or more
rooms, and publish them as walkable 3D spaces rendered with React Three Fiber
at `/museum/<slug>`.
The same tRPC procedures that back the web app are exposed over an MCP
endpoint (`/mcp`), so AI agents can run the full
import → enrich → curate → publish flow conversationally — see
[`apps/server/src/mcp/README.md`](apps/server/src/mcp/README.md).

Scaffolded with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack).

## Stack

- **TypeScript** end to end, **Bun** runtime, **Turborepo** monorepo
- **TanStack Start** (SSR + TanStack Router) for the web app
- **Hono** + **tRPC** for the API server
- **Drizzle** ORM on **PostgreSQL**
- **Clerk** authentication (browser sessions), plus `aqtg_` personal access
  tokens for agents
- **TailwindCSS** with shadcn/ui primitives from the workspace package `@aqt/ui`
- **Vite+**, with lint and format settings at the workspace root
- **three.js + React Three Fiber** museum renderer in
  `apps/web/src/components/museum/renderer/` — see its
  [README](apps/web/src/components/museum/renderer/README.md)

## Getting Started

First, install the dependencies from the workspace root:

```bash
bun install
```

## Database Setup

This project uses PostgreSQL with Drizzle ORM.

1. Make sure you have a PostgreSQL database set up.
2. Update your `apps/server/.env` file with your PostgreSQL connection details.

3. Apply the schema to your database:

```bash
bun run db:push
```

Then, run the development server:

```bash
bun run dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser to see the web application.
The API is running at [http://localhost:3000](http://localhost:3000).

## Media Storage

Every media byte goes through the `MediaStore` in `apps/server/src/media/store.ts`.
With no S3 variables set it writes to `UPLOAD_DIR` on local disk, which is what
development and tests use. Production runs on Cloudflare R2 over the S3 API.

The bucket is `aqt-gallery-media` (location hint `weur`, next to the Neon
database in `eu-central-1`). Wrangler is a dev dependency, so managing it needs
no global install:

```bash
bunx wrangler r2 bucket info aqt-gallery-media
```

To point the server at it, create an R2 API token scoped to that bucket with
**Object Read & Write** (Cloudflare dashboard: R2 > API > Manage API tokens).
Cloudflare shows the S3 access key ID and secret once, on creation. Then set all
four variables in `apps/server/.env` — the env schema rejects a partial
configuration, since a half-configured bucket boots the server and then fails
every media read:

```bash
S3_BUCKET=aqt-gallery-media
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=<access-key-id>
S3_SECRET_ACCESS_KEY=<secret-access-key>
```

Media already on disk moves over with a re-runnable copy of `originals/` and
`thumbs/` (the proxy cache is derived and regenerates on demand):

```bash
cd apps/server && bun run media:migrate
```

## Deployment

The API server runs as a container on the VPS and the web app on Vercel;
Postgres (Neon), media (R2) and identity (Clerk) are external. Vercel forwards
`/api/*` to `https://api.gallery.aquitano.me/*` with CDN caching off, so
authenticated responses stay private. `VITE_SERVER_URL` is
`https://gallery.aquitano.me/api`, not the API origin: Clerk's `__session`
cookie is host-only and only reaches the API through that same-origin path.
`CORS_ORIGIN`, also Clerk's authorized party, is the frontend origin
`https://gallery.aquitano.me`. Preview origins need their own auth
configuration.

### Server

The Dockerfile and compose file live in `apps/server`. The image runs
`src/index.ts` under Bun with a production install filtered to the server's
dependencies; the build context is the workspace root so bun can verify the
lockfile, and the root `.dockerignore` allowlists what that needs.

```bash
mise run gallery:secrets:send           # writes apps/gallery/apps/server/.env on the VPS
mise run gallery:deploy                 # pulls, builds and restarts it there
```

The container listens on 3000, published on loopback (`AQT_GALLERY_LISTEN`
overrides); the reverse proxy on the box terminates TLS for `SERVER_URL`.
Schema changes are applied from a checkout, not by the container: `bun run
db:migrate` inside `packages/db` with `DATABASE_URL` set to the production
database. Run it there and not through the root script, which goes through
turbo; its strict env mode drops the variable and drizzle falls back to the
dev `.env`.

To build and smoke-test the image locally:

```bash
cd apps/server && docker compose build
docker run --rm -p 3000:3000 --env-file .env aqt-gallery-server:local
```

### Web

`apps/web` builds through the nitro Vite plugin, which picks the Vercel preset
inside Vercel's build environment (`.vercel/output`) and the node-server preset
anywhere else (`bun run build` writes `.output/`; `bun .output/server/index.mjs`
runs it). `apps/web/vercel.json` sets the framework preset, `bunVersion` (Vercel's own
switch for the Bun line used to install, build and run; its default Bun 1.3
cannot read this lockfile), the function region (`fra1`, next to the API and
Neon), a filtered workspace install from the repository root, a plain
`vp build` so Vercel's Turbo detection stays out of the way, and an ignore
command so only changes under `apps/gallery` or `packages/ts/ui`, or to the
lockfile, trigger a build. The vite config names the matching `bun1.4.x` function runtime, since
nitro would otherwise emit `bun1.x`. When the Bun line moves in `mise.toml`,
move it in those two places as well.

The SSR build bundles dependencies together so generated CommonJS helpers
resolve React without adding a second copy. After a local build, run
`infisical run --env=dev --path=/web -- bun apps/web/scripts/check-ssr-bundle.ts`
from `apps/gallery`. The check imports every SSR chunk in isolation, renders
public pages, and checks the anonymous archive redirect.

One-time project setup in Vercel:

- Root Directory `apps/gallery/apps/web`, with "Include source files outside
  of the Root Directory" enabled.
- Environment variables `VITE_SERVER_URL`, `VITE_CLERK_PUBLISHABLE_KEY` and
  `CLERK_SECRET_KEY` (see `apps/web/.env.example`), for production and, if
  wanted, preview.
- The custom domain, which is then also `CORS_ORIGIN` on the server and the
  domain of the Clerk production instance.

With the Git integration connected every push to `main` deploys; `vercel --prod`
from `apps/web` does the same by hand.

## UI Customization

The shadcn/ui primitives and design tokens live in the workspace package `@aqt/ui` (`packages/ts/ui` at the workspace root), shared with the other aqt web apps.

- Change design tokens and global styles in `packages/ts/ui/src/styles/globals.css`
- Change gallery-only styles in `apps/web/src/gallery.css`
- Update shared primitives in `packages/ts/ui/src/components/*`
- Adjust shadcn aliases or style config in `packages/ts/ui/components.json` and `apps/web/components.json`

### Add more shared components

`packages/ts/ui/README.md` covers adding and updating shared components with the shadcn CLI, theming and charts.

Import shared components like this:

```tsx
import { Button } from "@aqt/ui/components/button";
```

### Add app-specific blocks

If you want to add app-specific blocks instead of shared primitives, run the shadcn CLI from `apps/web`.

## Formatting and Linting

- Lint, format check and typecheck: `mise run gallery:check`
- Static checks: `bun run check`. Format with `bunx --no-install vp fmt` from anywhere.

## Project Structure

```
aqt-gallery/
├── apps/
│   ├── web/             # Frontend (React + TanStack Start), 3D chrome + studio
│   └── server/          # Backend API (Hono, tRPC), media pipeline, MCP endpoint
├── packages/
│   ├── auth/            # Clerk-based session/auth resolution
│   ├── db/              # Drizzle schema & DB client
│   ├── env/             # Typed environment-variable validation
│   └── gallery-layout/  # Floor-plan graph + 3D layout shared by renderer, linter, studio
```

Shared shadcn/ui components and styles come from `@aqt/ui` in the workspace's `packages/ts/ui`.

## Available Scripts

- `bun run dev`: Start all applications in development mode
- `bun run build`: Build all applications
- `bun run dev:web`: Start only the web application
- `bun run dev:server`: Start only the server
- `bun run typecheck`: Check TypeScript types across Gallery packages
- `bun run db:push`: Push schema changes to database
- `bun run db:generate`: Generate database client/types
- `bun run db:migrate`: Run database migrations
- `bun run db:studio`: Open database studio UI
- `bun run check`: Formatting, type-aware lint, and TypeScript diagnostics with Vite+
- `bun run test`: Run the suite. It names source directories explicitly so the
  server's built `dist/` copies are not collected a second time.

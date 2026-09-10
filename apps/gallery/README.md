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
- **TailwindCSS** with shared shadcn/ui primitives in `packages/ui`
- **Biome** for linting and formatting
- **three.js + React Three Fiber** museum renderer in
  `apps/web/src/components/museum/renderer/` — see its
  [README](apps/web/src/components/museum/renderer/README.md)

## Getting Started

First, install the dependencies:

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

## UI Customization

React web apps in this stack share shadcn/ui primitives through `packages/ui`.

- Change design tokens and global styles in `packages/ui/src/styles/globals.css`
- Update shared primitives in `packages/ui/src/components/*`
- Adjust shadcn aliases or style config in `packages/ui/components.json` and `apps/web/components.json`

### Add more shared components

Run this from the project root to add more primitives to the shared UI package:

```bash
npx shadcn@latest add accordion dialog popover sheet table -c packages/ui
```

Import shared components like this:

```tsx
import { Button } from "@aqt-gallery/ui/components/button";
```

### Add app-specific blocks

If you want to add app-specific blocks instead of shared primitives, run the shadcn CLI from `apps/web`.

## Git Hooks and Formatting

- Format and lint fix: `bun run check`

## Project Structure

```
aqt-gallery/
├── apps/
│   ├── web/             # Frontend (React + TanStack Start), 3D chrome + studio
│   └── server/          # Backend API (Hono, tRPC), media pipeline, MCP endpoint
├── packages/
│   ├── auth/            # Clerk-based session/auth resolution
│   ├── config/          # Shared TypeScript/build config
│   ├── db/              # Drizzle schema & DB client
│   ├── env/             # Typed environment-variable validation
│   ├── gallery-layout/  # Floor-plan graph + 3D layout shared by renderer, linter, studio
│   └── ui/              # Shared shadcn/ui components and styles
```

## Available Scripts

- `bun run dev`: Start all applications in development mode
- `bun run build`: Build all applications
- `bun run dev:web`: Start only the web application
- `bun run dev:server`: Start only the server
- `bun run check-types`: Check TypeScript types across all apps
- `bun run db:push`: Push schema changes to database
- `bun run db:generate`: Generate database client/types
- `bun run db:migrate`: Run database migrations
- `bun run db:studio`: Open database studio UI
- `bun run check`: Run Biome formatting and linting

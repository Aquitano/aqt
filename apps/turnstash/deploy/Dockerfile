# Build context is the workspace root (aqt/), not this directory: the lockfile is resolved
# against every workspace manifest. Dockerfile.dockerignore limits the context to those
# manifests, turnstash and the shared TypeScript packages the web UI builds from.
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS web
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --filter aqt-turnstash --filter @aqt/turnstash-web
RUN bun run --cwd apps/turnstash/apps/web build

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4320
ENV WEB_DIST=/app/apps/turnstash/apps/web/dist
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production --filter @aqt/turnstash-server
COPY --from=web /app/apps/turnstash/apps/web/dist ./apps/turnstash/apps/web/dist
EXPOSE 4320
CMD ["bun", "apps/turnstash/apps/server/src/main.ts"]

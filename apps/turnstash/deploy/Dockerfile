FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/analysis/package.json packages/analysis/
COPY packages/api/package.json packages/api/
COPY packages/providers/package.json packages/providers/
COPY packages/pricing/package.json packages/pricing/
COPY apps/agent/package.json apps/agent/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run --cwd apps/web build

FROM oven/bun:1.4-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4320
ENV WEB_DIST=/app/apps/web/dist
COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
EXPOSE 4320
CMD ["bun", "apps/server/src/main.ts"]

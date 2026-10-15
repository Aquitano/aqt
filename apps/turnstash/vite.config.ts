import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "turnstash",
    include: [
      "apps/web/test/**/*.test.{ts,tsx}",
      "packages/api/test/**/*.test.ts",
      "packages/analysis/test/**/*.test.ts",
    ],
  },
});

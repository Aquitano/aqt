import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "gallery",
    include: ["packages/gallery-layout/src/**/*.test.ts", "apps/web/src/**/*.test.ts"],
  },
});

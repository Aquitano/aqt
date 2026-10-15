import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "tracker",
    include: ["src/**/*.test.ts"],
  },
});

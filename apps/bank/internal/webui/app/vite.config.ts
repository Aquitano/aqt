import path from "node:path";

import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";

// Built output is embedded into the Go binary (internal/webui). The dev server
// proxies /v1 to a locally running `bank ui` so `bun dev` works against real data.
export default defineConfig({
  test: { name: "bank", include: ["src/**/*.test.ts"] },
  plugins: lazyPlugins(() => [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()]),
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: {
    proxy: { "/v1": "http://127.0.0.1:8481" },
  },
});

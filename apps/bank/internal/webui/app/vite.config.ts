import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Built output is embedded into the Go binary (internal/webui). The dev server
// proxies /v1 to a locally running `bank ui` so `bun dev` works against real data.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: {
    proxy: { "/v1": "http://127.0.0.1:8481" },
  },
});

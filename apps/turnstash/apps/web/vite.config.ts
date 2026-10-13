import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), react(), babel({ presets: [reactCompilerPreset()] })],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:4320", "/auth": "http://localhost:4320" } },
});

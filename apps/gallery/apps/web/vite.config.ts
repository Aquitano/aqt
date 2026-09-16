import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3001,
    // Fail loudly if 3001 is taken instead of silently drifting to another
    // port — a drifted origin no longer matches the server's CORS_ORIGIN
    // and every API/auth request gets blocked.
    strictPort: true,
  },
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    // Keep CommonJS React imports in the bundle. Nitro cannot trace the
    // generated require helpers, and Vercel has no node_modules at runtime.
    noExternal: ["react", "react-dom"],
  },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    // vercel.json's bunVersion pins the build's Bun; on its own nitro would
    // still emit the function as bun1.x, which is Bun 1.3 on Vercel.
    nitro({ vercel: { functions: { runtime: "bun1.4.x" } } }),
    viteReact(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
});

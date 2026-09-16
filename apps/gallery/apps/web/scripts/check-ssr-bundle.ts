import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Run after `bun run build`. A checkout's node_modules can hide missing
// dependencies in the deployment bundle, so import every SSR chunk in isolation.
const output = fileURLToPath(new URL("../.output/server/", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "gallery-ssr-"));
try {
  const server = join(temporary, "server");
  await cp(output, server, { recursive: true });
  const chunks = join(server, "_ssr");
  const files = (await readdir(chunks)).filter((file) => file.endsWith(".mjs"));
  if (files.length === 0) throw new Error("No SSR chunks found. Build the web app first.");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-install",
      "-e",
      "for (const file of process.argv.slice(1)) await import(file)",
      ...files.map((file) => join(chunks, file)),
    ],
    {
      cwd: temporary,
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((await child.exited) !== 0)
    throw new Error("SSR bundle requires missing runtime dependencies.");
  console.log(`PASS: ${files.length} SSR chunks import without node_modules or auto-install.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

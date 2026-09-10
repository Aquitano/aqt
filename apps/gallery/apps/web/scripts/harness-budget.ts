/**
 * Render-budget guard for the museum renderer. Boots the web dev server, opens
 * the synthetic harness at the target scale and asserts the per-frame counters
 * the performance design depends on. Runs on software GL in CI, so it checks
 * counts, not frame time: a regression that adds per-painting lights or
 * un-instances the architecture fails here regardless of the GPU.
 */
import { chromium } from "playwright";

const PORT = 3001;
const HARNESS_URL = `http://localhost:${PORT}/dev/harness?rooms=25&works=100&auto=1`;
const BUDGET = { drawCalls: 90, lights: 9 };

/** CI boots the app with a placeholder publishable key, which decodes to no
 * frontend API host, so Clerk JS always fails to load. The harness renders
 * without it; every other page error is a real regression. */
const isClerkLoadFailure = (message: string) => message.includes("failed_to_load_clerk_js");

function killPort() {
  // `bun run dev` wraps Vite in a child process that outlives the wrapper,
  // so free the port by pid rather than trusting the wrapper's kill.
  const pids = Bun.spawnSync(["lsof", "-ti", `:${PORT}`]).stdout.toString();
  for (const pid of pids.split(/\s+/).filter(Boolean)) {
    Bun.spawnSync(["kill", pid]);
  }
}

killPort();
const server = Bun.spawn(["bun", "run", "dev"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdout: "ignore",
  stderr: "inherit",
});

async function waitForServer(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/`);
      if (res.ok || res.status === 307) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error("dev server did not start");
}

let failed = false;
try {
  await waitForServer(60_000);
  // CI installs Playwright's Chromium; locally PLAYWRIGHT_CHANNEL=chrome
  // reuses the system browser instead of downloading one.
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const errors: string[] = [];
  const ignored: string[] = [];
  page.on("pageerror", (e) => {
    (isClerkLoadFailure(e.message) ? ignored : errors).push(e.message);
  });
  await page.goto(HARNESS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const handle = await page.waitForFunction(
    () => window.__museumStats && window.__museumStats.drawCalls > 0,
    undefined,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(2000);
  const stats = (await handle.jsonValue()) as
    | { drawCalls: number; triangles: number; lights: number }
    | undefined;
  const latest = await page.evaluate(() => window.__museumStats);
  const s = latest ?? stats;
  if (!s) throw new Error("harness reported no frame stats");
  console.log(
    `25 rooms / 100 works: ${s.drawCalls} draw calls, ${s.lights} lights, ${s.triangles} triangles`,
  );
  if (s.drawCalls > BUDGET.drawCalls) {
    console.error(`draw calls ${s.drawCalls} exceed budget ${BUDGET.drawCalls}`);
    failed = true;
  }
  if (s.lights > BUDGET.lights) {
    console.error(`lights ${s.lights} exceed budget ${BUDGET.lights}`);
    failed = true;
  }
  // Logged rather than dropped silently, so a filtered error stays visible in
  // the run even though it does not fail the gate.
  if (ignored.length > 0) console.log("ignored page errors:", ignored);
  if (errors.length > 0) {
    console.error("page errors:", errors);
    failed = true;
  }
  await browser.close();
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  server.kill();
  killPort();
}
process.exit(failed ? 1 : 0);

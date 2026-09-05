/**
 * End-to-end smoke test for the editor against a running dev server.
 *
 *   bun run dev            # in another terminal, with Clerk dev keys in .env/.dev.vars
 *   bun scripts/e2e-smoke.ts [baseUrl]
 *
 * Signs in as a Backend-API-created test user, creates an album, exercises the
 * editor (upload, place, move, resize, rotate, caption, undo/redo, spreads,
 * reorder), enables sharing and opens the share link signed out. Screenshots
 * land in scripts/e2e-out/.
 */
import { mkdir } from "node:fs/promises";

import { type, type Type } from "arktype";
import { chromium, type Locator } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = "scripts/e2e-out";
const USERNAME = "smoke_test";

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

const shot = (name: string) => page.screenshot({ path: `${OUT}/${name}.png` });
const step = (name: string) => console.log(`- ${name}`);

/**
 * Sign in without the Clerk UI: create (or reuse) a test user through the
 * Backend API and consume a sign-in token via `__clerk_ticket`. Works no
 * matter which identifier strategies the instance enables and skips the bot
 * challenge that blocks headless sign-up.
 */
const clerkUser = type({ id: "string" });
const clerkSignInToken = type({ token: "string" });

type ClerkRequest =
  | { username: string; password: string }
  | { user_id: string; expires_in_seconds: number };

async function signIn() {
  step("sign in");
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) throw new Error("CLERK_SECRET_KEY is missing; put it in .env");
  const api = async <T extends Type>(
    path: string,
    schema: T,
    body?: ClerkRequest,
  ): Promise<T["infer"]> => {
    const response = await fetch(`https://api.clerk.com/v1${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok)
      throw new Error(`Clerk API ${path}: ${response.status} ${await response.text()}`);
    const parsed = schema(await response.json());
    if (parsed instanceof type.errors) throw new Error(`Clerk API ${path}: ${parsed.summary}`);
    return parsed;
  };
  const [existing] = await api(`/users?username=${USERNAME}&limit=1`, clerkUser.array());
  const user =
    existing ??
    (await api("/users", clerkUser, { username: USERNAME, password: "Album-smoke-test-1234" }));
  const { token } = await api("/sign_in_tokens", clerkSignInToken, {
    user_id: user.id,
    expires_in_seconds: 300,
  });

  await page.goto(`${BASE}/?__clerk_ticket=${token}`);
  await page.waitForURL(/\/albums/, { timeout: 30_000 });
  await shot("01-shelf");
}

async function createAlbum() {
  step("create album");
  await page.getByRole("button", { name: /new album/i }).click();
  const title = `Smoke ${new Date().toISOString().slice(11, 19)}`;
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: /^create$/i }).click();
  await page
    .getByRole("link", { name: new RegExp(title) })
    .first()
    .click();
  await page.waitForURL(/\/albums\/[^/]+$/);
  await page.locator("[data-sheet]").first().waitFor();
  await shot("02-album-closed");
}

async function enterEdit() {
  step("edit mode");
  await page.getByRole("button", { name: /^edit$/i }).click();
  await page.locator('[data-editable-page="left"]').waitFor();
  await shot("03-edit-mode");
}

async function uploadAndPlace() {
  step("upload photo");
  await page.getByRole("button", { name: /add photo/i }).click();
  const input = page.getByTestId("photo-input");
  await input.waitFor({ state: "attached" });
  const jpeg = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(1600, 1200);
    const ctx = canvas.getContext("2d")!;
    const gradient = ctx.createLinearGradient(0, 0, 1600, 1200);
    gradient.addColorStop(0, "#d9a066");
    gradient.addColorStop(1, "#3b6d8c");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1600, 1200);
    ctx.fillStyle = "#fff3";
    ctx.beginPath();
    ctx.arc(1150, 350, 180, 0, Math.PI * 2);
    ctx.fill();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  await input.setInputFiles({
    name: "sunset.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from(jpeg, "base64"),
  });
  const thumb = page.getByTestId("library-photo").first();
  await thumb.waitFor({ timeout: 30_000 });
  await shot("04-library");

  step("place photo");
  await thumb.click();
  await page.locator("[data-editable-page] [data-element]").first().waitFor();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: /^done$/i })
    .first()
    .waitFor();
  await shot("05-placed");
}

async function dragBy(target: Locator, dx: number, dy: number, steps = 12) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++)
    await page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps);
  await page.mouse.up();
}

async function transform() {
  const photo = page.locator("[data-editable-page] [data-element]").first();
  step("move");
  await dragBy(photo, -120, -80);
  await page.locator('[data-handle="corner-1-1"]').waitFor();
  await shot("06-moved");

  step("resize");
  await dragBy(page.locator('[data-handle="corner-1-1"]'), 60, 60);
  await shot("07-resized");

  step("rotate");
  await dragBy(page.locator('[data-handle="rotate"]'), 40, 20);
  await shot("08-rotated");
}

async function caption() {
  step("caption");
  await page.getByRole("button", { name: /add text/i }).click();
  const text = page.locator("[data-editable-page] [contenteditable]");
  await text.waitFor();
  await page.keyboard.type("Summer at the coast");
  await page.keyboard.press("Meta+Enter");
  await page.getByText("Summer at the coast").first().waitFor();
  await shot("09-caption");
}

async function undoRedo() {
  step("undo / redo");
  const count = () => page.locator("[data-editable-page] [data-element]").count();
  const before = await count();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+z");
  await page.keyboard.press("Meta+z");
  const afterUndo = await count();
  await page.keyboard.press("Shift+Meta+z");
  await page.keyboard.press("Shift+Meta+z");
  const afterRedo = await count();
  console.log(`  elements: ${before} -> undo ${afterUndo} -> redo ${afterRedo}`);
  // Two undos revert the caption's text and then its creation.
  if (afterUndo !== before - 1) throw new Error("undo did not remove the caption");
  if (afterRedo !== before) throw new Error("redo did not restore the elements");
}

async function spreads() {
  step("insert spread");
  await page.getByRole("button", { name: /insert spread after/i }).click();
  await page.getByRole("button", { name: /pages/i }).click();
  const items = page.locator("[data-spread]");
  await items.nth(1).waitFor();
  await settled(page.locator('[data-slot="sheet-content"]'));
  await shot("10-filmstrip");

  step("reorder spreads");
  const grips = page.getByRole("button", { name: /move spread 2/i });
  const first = (await items.nth(0).boundingBox())!;
  const grip = (await grips.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, first.y - 4, { steps: 10 });
  await page.mouse.up();
  await shot("11-reordered");
  await page.keyboard.press("Escape");
  await page.locator("[data-spread]").first().waitFor({ state: "hidden" });
}

/** Waits for CSS animations on a node (a sheet sliding in) so geometry is final. */
async function settled(target: Locator) {
  await target.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
}

async function waitSaved() {
  step("autosave");
  await page.locator('[role="status"][data-status="saved"]').waitFor({ timeout: 15_000 });
}

async function share() {
  step("share link");
  await page
    .getByRole("button", { name: /^done$/i })
    .first()
    .click();
  await page.getByRole("button", { name: /share/i }).click();
  await page.getByRole("switch").click();
  const url = await page.getByTestId("share-url").inputValue();
  await shot("12-share");
  console.log(`  ${url}`);

  const guest = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const view = await guest.newPage();
  await view.goto(url);
  await view.locator("[data-sheet]").first().waitFor();
  await view.screenshot({ path: `${OUT}/13-shared-closed.png` });
  await view.keyboard.press("ArrowRight");
  await view.keyboard.press("ArrowRight");
  await view.waitForTimeout(1200);
  await view.screenshot({ path: `${OUT}/14-shared-open.png` });
  await guest.close();

  step("phone view");
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const small = await phone.newPage();
  await small.goto(url);
  await small.locator("[data-sheet]").first().waitFor();
  await small.keyboard.press("ArrowRight");
  await small.waitForTimeout(1200);
  await small.screenshot({ path: `${OUT}/15-phone-shared.png` });
  await phone.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  if (await page.getByRole("button", { name: /^edit$/i }).isVisible())
    throw new Error("edit toggle shown on phone");
  await shot("16-phone-album");
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function reloadCheck() {
  step("reload persists");
  await page.reload();
  // The button exists in the server HTML before React hydrates, so retry until the click takes.
  const editable = page.locator('[data-editable-page="left"]');
  for (let attempt = 0; attempt < 10 && !(await editable.isVisible()); attempt++) {
    await page.getByRole("button", { name: /^edit$/i }).click();
    await editable.waitFor({ timeout: 1000 }).catch(() => undefined);
  }
  await editable.waitFor();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(1000);
  const n = await page.locator("[data-editable-page] [data-element]").count();
  console.log(`  elements after reload: ${n}`);
  await shot("17-reloaded");
}

try {
  await signIn();
  await createAlbum();
  await enterEdit();
  await uploadAndPlace();
  await transform();
  await caption();
  await undoRedo();
  await spreads();
  await waitSaved();
  await share();
  await reloadCheck();
  console.log(errors.length ? `console errors:\n${errors.join("\n")}` : "no console errors");
} catch (error) {
  await shot("99-failure");
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}

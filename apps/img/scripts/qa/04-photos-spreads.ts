/** Photo library uploads and deletes, spread insert/delete/reorder, D1 positions. */
import { writeFile } from "node:fs/promises";
import {
  BASE,
  OUT,
  check,
  clickUntil,
  createAlbum,
  desktop,
  launch,
  makeJpeg,
  pageGeom,
  probe,
  shot,
  signIn,
  summary,
} from "./lib";

const browser = await launch();
const ctx = await desktop(browser);
const page = await ctx.newPage();
const p = probe(page);

await signIn(page, `qa_photos_${Date.now().toString(36)}`);
const id = await createAlbum(page, `Photos ${Date.now().toString(36)}`);
await writeFile(`${OUT}/album-id.txt`, id);
const left = page.locator('[data-editable-page="left"]');
await clickUntil(page.getByRole("button", { name: /^edit$/i }), left);

await page.getByRole("button", { name: /add photo/i }).click();
const input = page.getByTestId("photo-input");
await input.waitFor({ state: "attached" });

// --- three at once ---
const before = await page.getByTestId("library-photo").count();
await input.setInputFiles([
  { name: "1.jpg", mimeType: "image/jpeg", buffer: await makeJpeg(page, 800, 600, 10) },
  { name: "2.jpg", mimeType: "image/jpeg", buffer: await makeJpeg(page, 600, 800, 120) },
  { name: "3.jpg", mimeType: "image/jpeg", buffer: await makeJpeg(page, 900, 900, 240) },
]);
await page.waitForFunction(
  (n) => document.querySelectorAll('[data-testid="library-photo"]').length >= n + 3,
  before,
  { timeout: 60_000 },
);
check(true, "three files upload in one go");
await shot(page, "30-library");

// --- non-image ---
await input.setInputFiles({
  name: "notes.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("hello"),
});
await page.waitForTimeout(2500);
const afterText = await page.getByTestId("library-photo").count();
const textToast = await page.locator("[data-sonner-toast]").count();
check(afterText === before + 3, "a non-image file is not uploaded", `${afterText} thumbs`);
check(textToast > 0, "a non-image file produces a visible message", `${textToast} toasts`);
await shot(page, "31-non-image");

// --- 0 byte file ---
await input.setInputFiles({ name: "empty.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(0) });
await page.waitForTimeout(3000);
const afterEmpty = await page.getByTestId("library-photo").count();
check(afterEmpty === afterText, "a 0-byte image is rejected", `${afterEmpty} thumbs`);
const emptyToast = await page.locator("[data-sonner-toast]").allInnerTexts();
check(
  emptyToast.length > 0,
  "a 0-byte image shows an error toast",
  JSON.stringify(emptyToast).slice(0, 120),
);
await shot(page, "32-empty-file");

// --- very large image ---
const big = await makeJpeg(page, 6000, 4000, 300);
const t0 = Date.now();
await input.setInputFiles({ name: "huge.jpg", mimeType: "image/jpeg", buffer: big });
const grew = await page
  .waitForFunction(
    (n) => document.querySelectorAll('[data-testid="library-photo"]').length > n,
    afterEmpty,
    { timeout: 90_000 },
  )
  .then(() => true)
  .catch(() => false);
check(
  grew,
  "a 6000px image uploads",
  `${((Date.now() - t0) / 1000).toFixed(1)}s, source ${(big.length / 1e6).toFixed(1)}MB`,
);
// The spec caps the display image at 2500px.
// Photos list newest first, so the 6000px one is the first thumbnail.
const dims = await page.evaluate(() => ({
  src: document.querySelector<HTMLImageElement>('[data-testid="library-photo"] img')?.src ?? "",
}));
const displayed = await page.evaluate(
  (src) =>
    new Promise<{ w: number; h: number }>((resolve) => {
      const i = new Image();
      i.onload = () => resolve({ w: i.naturalWidth, h: i.naturalHeight });
      i.onerror = () => resolve({ w: 0, h: 0 });
      i.src = src.replace("?thumb=1", "");
    }),
  dims.src,
);
check(
  displayed.w > 0 && displayed.w <= 2500,
  "the stored display image is capped at 2500px",
  `${displayed.w}x${displayed.h}`,
);

// --- delete a photo that is NOT placed ---
const countBefore = await page.getByTestId("library-photo").count();
await page.getByTestId("library-photo").first().hover();
await page
  .getByRole("button", { name: /delete photo/i })
  .first()
  .click();
await page.waitForTimeout(2000);
check(
  (await page.getByTestId("library-photo").count()) === countBefore - 1,
  "an unplaced photo deletes",
);

// --- delete a photo that IS placed: expect a 409 message, not a crash ---
await page.getByTestId("library-photo").first().click();
await left.locator("[data-element]").first().waitFor({ timeout: 10_000 });
// The dot starts on 'saved', so wait out the 800ms debounce plus the round trip.
await page.waitForTimeout(3000);
await page.locator('[role="status"][data-status="saved"]').waitFor({ timeout: 20_000 });
const placedCount = await page.getByTestId("library-photo").count();
await page.getByTestId("library-photo").first().hover();
await page
  .getByRole("button", { name: /delete photo/i })
  .first()
  .click();
await page.waitForTimeout(2500);
const toastText = (await page.locator("[data-sonner-toast]").allInnerTexts()).join(" | ");
check(
  (await page.getByTestId("library-photo").count()) === placedCount,
  "a placed photo is not deleted",
);
check(
  /still on a page|remove it there/i.test(toastText),
  "the 409 surfaces as a clear message",
  `toast: ${toastText.replace(/\n/g, " ").slice(0, 140)}`,
);
check((await pageGeom(page, "left")).length > 0, "the placed photo stays on the page");
await shot(page, "33-409");

// --- spreads ---
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
await page.getByRole("button", { name: /insert spread after/i }).click();
await page.waitForTimeout(2000);
await page.getByRole("button", { name: /^pages$/i }).click();
await page.waitForTimeout(800);
check((await page.locator("[data-spread]").count()) === 2, "insert after current adds a spread");
await shot(page, "34-filmstrip");
await page.keyboard.press("Escape");
await page.waitForTimeout(500);

// delete current, with confirmation
await page.getByRole("button", { name: /delete spread/i }).click();
const dialog = page.getByRole("dialog");
await dialog.waitFor({ timeout: 5000 });
check(true, "delete spread asks for confirmation");
await dialog.getByRole("button", { name: /^delete$/i }).click();
await page.waitForTimeout(2500);
await page.getByRole("button", { name: /^pages$/i }).click();
await page.waitForTimeout(800);
check((await page.locator("[data-spread]").count()) === 1, "delete removes the spread");
await page.keyboard.press("Escape");
await page.waitForTimeout(500);

// delete the only spread
const lastDisabled = await page.getByRole("button", { name: /delete spread/i }).isDisabled();
check(
  lastDisabled,
  "deleting the only spread is blocked in the toolbar",
  `disabled=${lastDisabled}`,
);

// reorder via the filmstrip
for (let i = 0; i < 2; i++) {
  await page.getByRole("button", { name: /insert spread after/i }).click();
  await page.waitForTimeout(1600);
}
await page
  .locator('[role="status"][data-status="saved"]')
  .waitFor({ timeout: 20_000 })
  .catch(() => undefined);
await page.getByRole("button", { name: /^pages$/i }).click();
await page.waitForTimeout(900);
const items = page.locator("[data-spread]");
const n = await items.count();
check(n === 3, "three spreads before reorder", `${n}`);
const idsBefore = await items.evaluateAll((els) =>
  els.map((e) => (e as HTMLElement).dataset.spread ?? ""),
);
const grip = page.getByRole("button", { name: /move spread 3/i });
const gb = (await grip.boundingBox())!;
const first = (await items.nth(0).boundingBox())!;
await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
await page.mouse.down();
await page.mouse.move(gb.x + gb.width / 2, first.y - 6, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(2500);
const idsAfter = await items.evaluateAll((els) =>
  els.map((e) => (e as HTMLElement).dataset.spread ?? ""),
);
check(
  idsBefore.join() !== idsAfter.join(),
  "filmstrip drag reorders",
  `${idsBefore.join()} -> ${idsAfter.join()}`,
);
await shot(page, "35-reordered");
await page.keyboard.press("Escape");
await page
  .locator('[role="status"][data-status="saved"]')
  .waitFor({ timeout: 20_000 })
  .catch(() => undefined);
await page.waitForTimeout(1500);

await writeFile(`${OUT}/expected-order.txt`, idsAfter.join("\n"));
console.log(`album: ${BASE}/albums/${id}`);
console.log(`expected order: ${idsAfter.join(",")}`);
summary([p]);
await browser.close();

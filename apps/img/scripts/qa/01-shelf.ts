/** Shelf: empty state, create with each material, rename, delete, dark mode. */
import { BASE, check, clickUntil, desktop, launch, probe, shot, signIn, summary } from "./lib";

const browser = await launch();
const ctx = await desktop(browser);
const page = await ctx.newPage();
const p = probe(page);

// A user with no albums yet, so the empty state is real.
const fresh = `qa_empty_${Date.now().toString(36)}`;
await signIn(page, fresh);
await page.getByRole("heading", { name: "Albums" }).waitFor();
const emptyVisible = await page
  .getByText("No albums yet")
  .isVisible()
  .catch(() => false);
check(emptyVisible, "shelf empty state");
await shot(page, "01-empty-shelf");

const materials = ["linen", "leather", "cloth"] as const;
for (const material of materials) {
  await page.getByRole("button", { name: /new album/i }).click();
  await page.getByLabel("Title").fill(`QA ${material}`);
  await page.getByRole("dialog").getByText(material, { exact: true }).click();
  await page.getByRole("button", { name: /^create$/i }).click();
  await page
    .getByRole("link", { name: new RegExp(`QA ${material}`) })
    .first()
    .waitFor({ timeout: 15_000 });
}
check(true, "created albums with linen / leather / cloth");
await shot(page, "02-shelf-three");

// --- dark mode from the shelf's own toggle ---
const toggle = page.getByRole("button", { name: /^theme$/i });
check(
  (await toggle.count()) > 0,
  "a dark-mode toggle exists in the UI",
  `found ${await toggle.count()}`,
);
const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
await toggle.click();
await page.getByRole("menuitem", { name: /^dark$/i }).click();
await page.waitForTimeout(400);
const dark = await page.evaluate(() => ({
  classed: document.documentElement.classList.contains("dark"),
  bg: getComputedStyle(document.body).backgroundColor,
}));
check(dark.classed, "the toggle puts the app in dark mode");
check(dark.bg !== lightBg, "dark mode changes the chrome background", `${lightBg} -> ${dark.bg}`);
await shot(page, "03-shelf-dark");
await toggle.click();
await page.getByRole("menuitem", { name: /^light$/i }).click();
await page.waitForTimeout(300);

// Rename lives on the album page, not the shelf.
await page
  .getByRole("link", { name: /QA linen/ })
  .first()
  .click();
await page.waitForURL(/\/albums\/[^/]+$/);
const albumId = page.url().split("/").pop()!;
await clickUntil(page.getByRole("button", { name: "QA linen" }), page.getByLabel("Album title"));
await page.getByLabel("Album title").fill("QA renamed");
await page.keyboard.press("Enter");
await page.waitForTimeout(1200);
await page.goto(`${BASE}/albums`);
const renamed = await page
  .getByText("QA renamed")
  .first()
  .isVisible()
  .catch(() => false);
check(renamed, "rename propagates to the shelf");
await shot(page, "04-renamed");

// Rename to whitespace only.
await page.goto(`${BASE}/albums/${albumId}`);
await clickUntil(page.getByRole("button", { name: "QA renamed" }), page.getByLabel("Album title"));
await page.getByLabel("Album title").fill("   ");
await page.keyboard.press("Enter");
await page.waitForTimeout(800);
const stillNamed = await page
  .getByRole("button", { name: "QA renamed" })
  .isVisible()
  .catch(() => false);
check(stillNamed, "blank rename is rejected, title unchanged");

// Delete asks first, then removes.
await page.goto(`${BASE}/albums`);
await page.getByRole("button", { name: /Actions for QA cloth/ }).click();
await page.getByRole("menuitem", { name: /delete/i }).click();
const confirm = page.getByRole("dialog");
const confirmShown = await confirm.isVisible({ timeout: 5000 }).catch(() => false);
check(confirmShown, "album delete asks for confirmation", `dialog visible: ${confirmShown}`);
await confirm.getByRole("button", { name: /^delete$/i }).click();
await page.waitForTimeout(1800);
const gone = (await page.getByText("QA cloth").count()) === 0;
check(gone, "deleted album disappears from the shelf");
await shot(page, "05-after-delete");

console.log(`\nQA user: ${fresh}`);
summary([p]);
await browser.close();

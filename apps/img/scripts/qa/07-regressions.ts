/** Targeted probes for undo history, autosave durability and resize maths. */
import {
  BASE,
  check,
  clickUntil,
  createAlbum,
  desktop,
  dragFromTo,
  launch,
  makeJpeg,
  pageBox,
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

await signIn(page, "qa_regress");
const id = await createAlbum(page, `Regress ${Date.now().toString(36)}`);
const left = page.locator('[data-editable-page="left"]');
await clickUntil(page.getByRole("button", { name: /^edit$/i }), left);

await page.getByRole("button", { name: /add photo/i }).click();
const input = page.getByTestId("photo-input");
await input.waitFor({ state: "attached" });
await input.setInputFiles({
  name: "r.jpg",
  mimeType: "image/jpeg",
  buffer: await makeJpeg(page, 1400, 1000, 90),
});
await page.getByTestId("library-photo").first().waitFor({ timeout: 40_000 });
await page.getByTestId("library-photo").first().click();
await left.locator("[data-element]").first().waitFor({ timeout: 10_000 });
await page.keyboard.press("Escape");
await page.waitForTimeout(500);

const el = left.locator("[data-element]").first();
const geom = async () => (await pageGeom(page, "left"))[0];

// --- 1. Aspect resize: can a single-axis inward drag shrink the photo? ---
await el.click();
await page.waitForTimeout(250);
const beforeShrink = await geom();
const h = page.locator('[data-handle="corner-1-1"]');
let hb = (await h.boundingBox())!;
await dragFromTo(
  page,
  { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 },
  { x: hb.x - 120, y: hb.y },
  { steps: 16 },
);
await page.waitForTimeout(300);
const afterShrink = await geom();
check(
  afterShrink.w < beforeShrink.w - 20,
  "dragging a corner straight inward shrinks the photo",
  `w ${beforeShrink.w.toFixed(0)} -> ${afterShrink.w.toFixed(0)}`,
);

// --- 2. A long drag must still be one undo step, and must not eat history ---
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
// Build three distinct history entries first.
await el.click();
for (let i = 0; i < 3; i++) {
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(120);
}
const beforeLong = await geom();
let eb = (await el.boundingBox())!;
// ~160 pointermoves: past zundo's limit of 100 history entries.
await dragFromTo(
  page,
  { x: eb.x + eb.width / 2, y: eb.y + eb.height / 2 },
  { x: eb.x + eb.width / 2 + 200, y: eb.y + eb.height / 2 + 120 },
  { steps: 160 },
);
await page.waitForTimeout(400);
const afterLong = await geom();
await page.keyboard.press("Escape");
await page.keyboard.press("Meta+z");
await page.waitForTimeout(400);
const undoneLong = await geom();
check(
  Math.abs(undoneLong.x - beforeLong.x) < 3 && Math.abs(undoneLong.y - beforeLong.y) < 3,
  "one undo reverts a long (160-move) drag completely",
  `pre (${beforeLong.x.toFixed(0)},${beforeLong.y.toFixed(0)}) post (${afterLong.x.toFixed(0)},${afterLong.y.toFixed(0)}) undone (${undoneLong.x.toFixed(0)},${undoneLong.y.toFixed(0)})`,
);
// The three nudges before the drag should still be undoable.
const undoCount = await page.evaluate(
  () => document.querySelectorAll('[aria-label="Undo"]:not([disabled])').length,
);
check(undoCount > 0, "history before a long drag survives it", `undo enabled=${undoCount > 0}`);
await shot(page, "60-long-drag");

// --- 3. Autosave must flush when leaving the page ---
await page.waitForTimeout(2500);
await el.click();
await page.waitForTimeout(200);
const beforeLeave = await geom();
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(120);
const movedAway = await geom();
// Navigate away immediately, inside the 800ms debounce window.
await page.getByRole("link", { name: /back to albums/i }).click();
await page.waitForURL(/\/albums$/, { timeout: 15_000 });
await page.waitForTimeout(2000);
await page.goto(`${BASE}/albums/${id}`);
await clickUntil(page.getByRole("button", { name: /^edit$/i }), left);
await page.waitForTimeout(1000);
const afterReturn = await geom();
check(
  Math.abs(afterReturn.y - movedAway.y) < 2,
  "an edit made just before navigating away is saved",
  `was ${beforeLeave.y.toFixed(0)}, nudged to ${movedAway.y.toFixed(0)}, reloaded ${afterReturn.y.toFixed(0)}`,
);

// --- 4. Undo of a spread delete must not lose that spread's content ---
await page.getByRole("button", { name: /insert spread after/i }).click();
await page.waitForTimeout(2000);
await page.getByRole("button", { name: /add text/i }).click();
await page.waitForTimeout(400);
await page.keyboard.press("Meta+A");
await page.keyboard.type("Do not lose me");
await page.keyboard.press("Meta+Enter");
await page.waitForTimeout(3000);
const onSecond = await pageGeom(page, "left");
check(
  onSecond.length > 0 || (await pageGeom(page, "right")).length > 0,
  "the caption landed on the new spread",
);
await page.getByRole("button", { name: /delete spread/i }).click();
await page
  .getByRole("dialog")
  .getByRole("button", { name: /^delete$/i })
  .click();
await page.waitForTimeout(2500);
await page.keyboard.press("Escape");
await page.keyboard.press("Meta+z");
await page.waitForTimeout(1500);
// Undo puts the spread back behind the current one, so go and look at it.
await page.keyboard.press("End");
await page.waitForTimeout(2500);
const restoredInClient = await page.evaluate(() =>
  document.body.innerText.includes("Do not lose me"),
);
await page.goto(`${BASE}/albums/${id}`);
await page.waitForTimeout(1500);
await clickUntil(page.getByRole("button", { name: /^edit$/i }), left);
await page.keyboard.press("End");
await page.waitForTimeout(1500);
const survived = await page.evaluate(() => document.body.innerText.includes("Do not lose me"));
check(
  restoredInClient && survived,
  "undoing a spread delete keeps its content after a reload",
  `restored in client=${restoredInClient}, present after reload=${survived}`,
);
await shot(page, "61-undo-delete-spread");

// --- 5. Two structural changes back to back ---
const badBefore = p.requests.length;
await page.getByRole("button", { name: /insert spread after/i }).click();
await page.getByRole("button", { name: /insert spread after/i }).click();
await page.getByRole("button", { name: /insert spread after/i }).click();
await page.waitForTimeout(5000);
const newBad = p.requests.slice(badBefore);
check(
  newBad.length === 0,
  "rapid spread inserts do not produce failed requests",
  newBad.join(" | ").slice(0, 200),
);
const status = await page.locator('[role="status"]').getAttribute("data-status");
check(status === "saved", "the save dot ends on saved after rapid inserts", `status=${status}`);
await shot(page, "62-rapid-inserts");

// --- 6. Double-click a caption enters inline editing, Esc puts it back ---
await page.getByRole("button", { name: /insert spread after/i }).click();
await page.waitForTimeout(2000);
await page.getByRole("button", { name: /add text/i }).click();
await page.waitForTimeout(400);
await page.keyboard.press("Meta+A");
await page.keyboard.type("Tap me twice");
await page.keyboard.press("Meta+Enter");
await page.waitForTimeout(600);
const caption = page.locator('[data-editable-page="left"] [data-element]').first();
await caption.dblclick();
await page.waitForTimeout(500);
const editableNodes = await page.locator("[data-editable-page] [contenteditable]").count();
check(
  editableNodes === 1,
  "double-click on a caption enters inline editing",
  `${editableNodes} editable nodes`,
);

await page.keyboard.press("Meta+A");
await page.keyboard.type("Throw me away");
await page.waitForTimeout(200);
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
const onScreen = await page.evaluate(() => document.body.innerText);
check(
  !onScreen.includes("Throw me away") && onScreen.includes("Tap me twice"),
  "Esc puts the original caption back on the page, not just in the store",
  `still showing the draft: ${onScreen.includes("Throw me away")}`,
);
await shot(page, "63-dblclick-edit");

// --- 7. Z-order steps only pass elements on the same page ---
// Park the first caption so the next one does not land on top of it.
const box = await pageBox(page, "left");
const first = (await caption.boundingBox())!;
await dragFromTo(
  page,
  { x: first.x + first.width / 2, y: first.y + first.height / 2 },
  { x: box.x + 250 * box.scale, y: box.y + 150 * box.scale },
);
await page.waitForTimeout(400);
// Deselected, the next caption goes to the emptier page, so the spread reads
// left, right, left: one z-order step must jump the middle, right-page one.
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await page.getByRole("button", { name: /add text/i }).click();
await page.keyboard.press("Meta+Enter");
await page.waitForTimeout(600);
await caption.click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: /add text/i }).click();
await page.keyboard.press("Meta+Enter");
await page.waitForTimeout(600);
const leftOrder = async () => (await pageGeom(page, "left")).map((g) => g.id).join(",");
const rightCount = (await pageGeom(page, "right")).length;
const zBefore = await leftOrder();
await caption.click();
await page.waitForTimeout(300);
await page.keyboard.down("Meta");
await page.keyboard.press("BracketRight");
await page.keyboard.up("Meta");
await page.waitForTimeout(400);
const zAfter = await leftOrder();
check(
  rightCount === 1 && zBefore !== zAfter,
  "one z-order step passes the next element on the same page, not the other page",
  `left ${zBefore} -> ${zAfter}, right page holds ${rightCount}`,
);

// --- 8. An element cannot be dragged off the page ---
const runaway = (await pageGeom(page, "left"))[0];
const node = page.locator('[data-editable-page="left"] [data-element]').first();
const nb = (await node.boundingBox())!;
await dragFromTo(
  page,
  { x: nb.x + nb.width / 2, y: nb.y + nb.height / 2 },
  { x: box.x - box.size * 0.6, y: box.y + box.size / 2 },
  { steps: 20 },
);
await page.waitForTimeout(400);
const clamped = (await pageGeom(page, "left"))[0];
const onPage = Math.min(1000, clamped.x + clamped.w) - Math.max(0, clamped.x);
check(
  clamped.x < runaway.x - 100 && onPage >= clamped.w * 0.1 - 1,
  "at least a tenth of a dragged element stays on the page",
  `x ${runaway.x.toFixed(0)} -> ${clamped.x.toFixed(0)}, ${onPage.toFixed(0)} of ${clamped.w.toFixed(0)} units still on the page`,
);

// --- 9. Dark mode darkens the desk, the paper stays paper ---
const desk = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const paper = () =>
  page.evaluate(() => getComputedStyle(document.querySelector("[data-paper]")!).backgroundColor);
const lightDesk = await desk();
const lightPaper = await paper();
await page.getByRole("button", { name: /^theme$/i }).click();
await page.getByRole("menuitemradio", { name: /^dark$/i }).click();
await page.waitForTimeout(600);
const darkDesk = await desk();
const darkPaper = await paper();
check(darkDesk !== lightDesk, "dark mode darkens the desk", `${lightDesk} -> ${darkDesk}`);
check(darkPaper === lightPaper, "paper stays paper in dark mode", `${lightPaper} -> ${darkPaper}`);
await shot(page, "64-dark-album");

summary([p]);
await browser.close();

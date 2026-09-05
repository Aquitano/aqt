/** Scratch probe for the double-click-to-edit and Cmd-[ z-order failures. */
import {
  check,
  clickUntil,
  createAlbum,
  desktop,
  launch,
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

await signIn(page, "qa_debug");
await createAlbum(page, `Debug ${Date.now().toString(36)}`);
const left = page.locator('[data-editable-page="left"]');
await clickUntil(page.getByRole("button", { name: /^edit$/i }), left);

// Two text elements so z-order is observable without a photo in the way.
await page.getByRole("button", { name: /add text/i }).click();
await page.waitForTimeout(300);
await page.keyboard.press("Meta+Enter");
await page.waitForTimeout(400);
// Keep the first caption selected so the second one lands on the same page.
await left.locator("[data-element]").first().click();
await page.waitForTimeout(250);
await page.getByRole("button", { name: /add text/i }).click();
await page.waitForTimeout(300);
await page.keyboard.press("Meta+Enter");
await page.waitForTimeout(400);

const order = async () => (await pageGeom(page, "left")).map((g) => g.id).join(",");
console.log("order", await order(), "count", (await pageGeom(page, "left")).length);

// Does a native mouse dblclick reach the page at all?
await page.evaluate(() => {
  const root = document.querySelector('[data-editable-page="left"]')!;
  (window as unknown as { seen: string[] }).seen = [];
  for (const t of ["pointerdown", "mousedown", "click", "dblclick"]) {
    root.addEventListener(t, (e) =>
      (window as unknown as { seen: string[] }).seen.push(
        `${t}:${(e.target as HTMLElement).dataset?.element ?? (e.target as HTMLElement).tagName}`,
      ),
    );
  }
});

const target = left.locator("[data-element]").last();
await target.click();
await page.waitForTimeout(250);
console.log("selected handles:", await page.locator("[data-handle]").count());
await target.dblclick();
await page.waitForTimeout(400);
const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
console.log("events after click+dblclick:", JSON.stringify(seen));
check(
  (await page.locator("[contenteditable]").count()) > 0,
  "dblclick on a selected caption starts editing",
);

// Same on an unselected element.
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
await page.evaluate(() => ((window as unknown as { seen: string[] }).seen = []));
await target.dblclick();
await page.waitForTimeout(400);
console.log(
  "events (unselected):",
  JSON.stringify(await page.evaluate(() => (window as unknown as { seen: string[] }).seen)),
);
check(
  (await page.locator("[contenteditable]").count()) > 0,
  "dblclick on an unselected caption starts editing",
);
await shot(page, "90-dblclick");

// What does the page actually see for the z-order chords?
await page.evaluate(() => {
  (window as unknown as { keys: string[] }).keys = [];
  window.addEventListener(
    "keydown",
    (e) =>
      (window as unknown as { keys: string[] }).keys.push(
        `${e.key}|meta:${e.metaKey}|code:${e.code}|default:${e.defaultPrevented}`,
      ),
    true,
  );
});
await page.keyboard.down("Meta");
await page.keyboard.press("BracketRight");
await page.keyboard.press("BracketLeft");
await page.keyboard.up("Meta");
await page.waitForTimeout(200);
console.log(
  "keys seen:",
  JSON.stringify(await page.evaluate(() => (window as unknown as { keys: string[] }).keys)),
);

// Z-order key variants.
await page.keyboard.press("Escape");
await target.click();
await page.waitForTimeout(250);
const o0 = await order();
await page.keyboard.down("Meta");
await page.keyboard.press("BracketLeft");
await page.keyboard.up("Meta");
await page.waitForTimeout(300);
console.log("after Meta+BracketLeft:", o0, "->", await order());
await page.keyboard.press("Control+BracketLeft");
await page.waitForTimeout(300);
console.log("after Control+BracketLeft:", await order());
// The toolbar buttons should do the same job.
await page.getByRole("button", { name: /send backward/i }).click();
await page.waitForTimeout(300);
console.log("after toolbar Send backward:", await order());

summary([p]);
await browser.close();

/** View mode: cover, drag turning, click edges, keyboard, ends, reduced motion. */
import {
  BASE,
  check,
  clickUntil,
  createAlbum,
  desktop,
  dragFromTo,
  launch,
  probe,
  shot,
  signIn,
  sheetAngles,
  summary,
  turnedIndex,
} from './lib'

const browser = await launch()
const ctx = await desktop(browser)
const page = await ctx.newPage()
const p = probe(page)

await signIn(page, 'qa_book')
const id = await createAlbum(page, `Book ${Date.now().toString(36)}`)

// Give the book four spreads so there is something to page through.
await clickUntil(page.getByRole('button', { name: /^edit$/i }), page.locator('[data-editable-page="left"]'))
for (let i = 0; i < 3; i++) await page.getByRole('button', { name: /insert spread after/i }).click()
await page.locator('[role="status"][data-status="saved"]').waitFor({ timeout: 20_000 })
await page.getByRole('button', { name: /^done$/i }).first().click()
await page.goto(`${BASE}/albums/${id}`)
await page.locator('[data-sheet]').first().waitFor()
await page.waitForTimeout(600)

const settle = () => page.waitForTimeout(900)

/** The book box, read from the sheets' shared parent, so the spine is right. */
const geo = async () => {
  const r = await page.evaluate(() => {
    const box = document.querySelector('[data-sheet]')!.parentElement!.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  })
  return { spineX: r.x + r.width / 2, top: r.y, h: r.height, w: r.width / 2 }
}

const opening = await turnedIndex(page)
check(opening === 0, 'album page opens on the closed front cover', `turned=${opening} (0 = closed, 2 = first spread)`)
await shot(page, '10-closed')

// --- click the right page edge to open ---
await page.keyboard.press('Home')
await settle()
const gc = await geo()
await page.mouse.click(gc.spineX + gc.w * 0.95, gc.top + gc.h / 2)
await settle()
check((await turnedIndex(page)) === 1, 'clicking the cover edge opens the book', `turned=${await turnedIndex(page)}`)
await shot(page, '11-opened')

// --- drag forward past halfway: must complete ---
let g = await geo()
let before = await turnedIndex(page)
await dragFromTo(page, { x: g.spineX + g.w * 0.95, y: g.top + g.h / 2 }, { x: g.spineX - g.w * 0.7, y: g.top + g.h / 2 }, { steps: 20 })
await settle()
check((await turnedIndex(page)) === before + 1, 'slow drag past halfway completes the turn', `${before} -> ${await turnedIndex(page)}`)
await shot(page, '12-dragged-forward')

// --- partial drag then release below 0.5: must spring back ---
g = await geo()
before = await turnedIndex(page)
await dragFromTo(
  page,
  { x: g.spineX + g.w * 0.95, y: g.top + g.h / 2 },
  { x: g.spineX + g.w * 0.7, y: g.top + g.h / 2 },
  { steps: 20 },
)
await settle()
const after = await turnedIndex(page)
check(after === before, 'partial drag below 0.5 springs back', `${before} -> ${after}`)
const angles = await page.evaluate(() => {
  const el = document.querySelector<HTMLElement>('[data-sheet]')!
  return getComputedStyle(el).transform
})
await shot(page, '13-spring-back')

// --- flick: fast short drag must complete ---
g = await geo()
before = await turnedIndex(page)
await dragFromTo(page, { x: g.spineX + g.w * 0.95, y: g.top + g.h / 2 }, { x: g.spineX + g.w * 0.45, y: g.top + g.h / 2 }, { steps: 3 })
await settle()
check((await turnedIndex(page)) === before + 1, 'a fast flick completes the turn', `${before} -> ${await turnedIndex(page)}`)

// --- drag backward (grab the left stack) ---
g = await geo()
before = await turnedIndex(page)
await dragFromTo(page, { x: g.spineX - g.w * 0.95, y: g.top + g.h / 2 }, { x: g.spineX + g.w * 0.8, y: g.top + g.h / 2 }, { steps: 20 })
await settle()
check((await turnedIndex(page)) === before - 1, 'dragging the left stack turns backward', `${before} -> ${await turnedIndex(page)}`)
await shot(page, '14-dragged-back')

// --- keyboard ---
await page.keyboard.press('Home')
await settle()
check((await turnedIndex(page)) === 0, 'Home closes the book', `turned=${await turnedIndex(page)}`)

before = await turnedIndex(page)
await page.keyboard.press('ArrowRight')
await settle()
check((await turnedIndex(page)) === before + 1, 'ArrowRight turns forward')
await page.keyboard.press('ArrowLeft')
await settle()
check((await turnedIndex(page)) === before, 'ArrowLeft turns backward')

await page.keyboard.press('End')
await settle()
const atEnd = await turnedIndex(page)
// 4 spreads -> sheets = 1 cover + 5 leaves = 6; fully open at the back is turned === 6.
check(atEnd === 6, 'End opens the book at the back cover', `turned=${atEnd}, expected 6`)
await shot(page, '15-end')

// Push past the back cover and come back.
for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
await settle()
const past = await turnedIndex(page)
check(past === 6, 'ArrowRight past the back cover is clamped', `turned=${past}`)
await shot(page, '16-back-cover')
await page.keyboard.press('ArrowLeft')
await settle()
check((await turnedIndex(page)) === past - 1, 'ArrowLeft from the back cover comes back')

// --- keyboard while an input is focused must not turn ---
await page.keyboard.press('Home')
await settle()
await clickUntil(page.getByRole('button', { name: /^Book / }), page.getByLabel('Album title'))
const focusedTurn = await turnedIndex(page)
await page.getByLabel('Album title').press('ArrowRight')
await page.getByLabel('Album title').press('End')
await settle()
check((await turnedIndex(page)) === focusedTurn, 'arrow/End in the title input does not turn pages', `turned=${await turnedIndex(page)}`)
await page.keyboard.press('Escape')

// --- reduced motion ---
await page.emulateMedia({ reducedMotion: 'reduce' })
await page.reload()
await page.locator('[data-sheet]').first().waitFor()
await page.waitForTimeout(600)
const rBefore = await turnedIndex(page)
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(60)
const midAngles = await sheetAngles(page)
await page.waitForTimeout(500)
const reducedTurn = await turnedIndex(page)
check(reducedTurn === rBefore + 1, 'reduced motion still turns pages', `${rBefore} -> ${reducedTurn}`)
// A crossfade never parks a leaf at an in-between angle.
const partial = Object.values(midAngles).filter((a) => Math.abs(a) > 5 && Math.abs(a) < 175)
check(partial.length === 0, 'reduced motion crossfades instead of rotating', `mid-turn angles: ${JSON.stringify(midAngles)}`)
await shot(page, '17-reduced-motion')
await page.emulateMedia({ reducedMotion: null })

console.log(`album: ${BASE}/albums/${id}`)
console.log(`spring-back transform: ${angles}`)
summary([p])
await browser.close()

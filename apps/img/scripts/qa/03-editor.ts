/** Editor: placement, transforms, keyboard, text, undo/redo, autosave. */
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
  selectedId,
  shot,
  signIn,
  summary,
  turnedIndex,
} from './lib'

const browser = await launch()
const ctx = await desktop(browser)
const page = await ctx.newPage()
const p = probe(page)

await signIn(page, 'qa_editor')
const id = await createAlbum(page, `Editor ${Date.now().toString(36)}`)
const left = page.locator('[data-editable-page="left"]')
const right = page.locator('[data-editable-page="right"]')

// --- E enters and leaves edit mode ---
await page.locator('[data-sheet]').first().click({ position: { x: 5, y: 5 } }).catch(() => undefined)
await page.keyboard.press('e')
const enteredWithE = await left.isVisible({ timeout: 3000 }).catch(() => false)
check(enteredWithE, 'E enters edit mode')
if (enteredWithE) {
  await page.keyboard.press('e')
  check(!(await left.isVisible().catch(() => false)), 'E leaves edit mode')
}
await clickUntil(page.getByRole('button', { name: /^edit$/i }), left)
check(true, 'toolbar Edit enters edit mode')

// --- upload two photos ---
await page.getByRole('button', { name: /add photo/i }).click()
const input = page.getByTestId('photo-input')
await input.waitFor({ state: 'attached' })
await input.setInputFiles([
  { name: 'a.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(page, 1600, 1200, 20) },
  { name: 'b.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(page, 1200, 1600, 200) },
])
await page.getByTestId('library-photo').nth(1).waitFor({ timeout: 40_000 })

// --- place by click: goes to the emptier page (left) ---
await page.getByTestId('library-photo').first().click()
await left.locator('[data-element]').first().waitFor({ timeout: 10_000 })
check((await pageGeom(page, 'left')).length === 1, 'click-to-place lands on the left page')

// --- place by drag onto the RIGHT page ---
const thumb = page.getByTestId('library-photo').nth(1)
// How much of the right page does the open library sheet cover?
const overlap = await page.evaluate(() => {
  const p = document.querySelector<HTMLElement>('[data-editable-page="right"]')!.getBoundingClientRect()
  const s = document.querySelector<HTMLElement>('[data-slot="sheet-content"]')!.getBoundingClientRect()
  return { pct: Math.round((Math.max(0, p.right - s.left) / p.width) * 100), pageRight: Math.round(p.right), sheetLeft: Math.round(s.left) }
})
check(overlap.pct <= 60, 'the open photo library leaves most of the right page reachable for a drop', `${overlap.pct}% covered (page right ${overlap.pageRight}, sheet left ${overlap.sheetLeft})`)
await thumb.dragTo(right, { targetPosition: { x: 80, y: 300 } })
await page.waitForTimeout(800)
const droppedRight = (await pageGeom(page, 'right')).length
const droppedLeft = (await pageGeom(page, 'left')).length
check(droppedRight === 1, 'drag-drop lands on the page it was dropped on (right)', `left ${droppedLeft}, right ${droppedRight}`)
await shot(page, '20-placed')

// Close the library sheet so it does not swallow pointer events.
await page.keyboard.press('Escape')
await page.waitForTimeout(400)

// --- move ---
const el = left.locator('[data-element]').first()
let before = (await pageGeom(page, 'left'))[0]
let eb = (await el.boundingBox())!
await dragFromTo(page, { x: eb.x + eb.width / 2, y: eb.y + eb.height / 2 }, { x: eb.x + eb.width / 2 - 120, y: eb.y + eb.height / 2 - 90 })
await page.waitForTimeout(300)
let now = (await pageGeom(page, 'left'))[0]
check(Math.abs(now.x - before.x) > 50 && Math.abs(now.y - before.y) > 30, 'body drag moves the element', `dx=${(now.x - before.x).toFixed(0)} dy=${(now.y - before.y).toFixed(0)}`)

// --- shift axis lock ---
before = now
eb = (await el.boundingBox())!
await dragFromTo(page, { x: eb.x + eb.width / 2, y: eb.y + eb.height / 2 }, { x: eb.x + eb.width / 2 + 100, y: eb.y + eb.height / 2 + 60 }, { modifier: 'Shift' })
await page.waitForTimeout(300)
now = (await pageGeom(page, 'left'))[0]
check(Math.abs(now.y - before.y) < 2, 'Shift locks movement to one axis', `dy=${(now.y - before.y).toFixed(1)}`)

// --- corner resize (aspect locked for photos) ---
before = now
const handle = page.locator('[data-handle="corner-1-1"]')
let hb = (await handle.boundingBox())!
await dragFromTo(page, { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, { x: hb.x + 80, y: hb.y + 20 })
await page.waitForTimeout(300)
now = (await pageGeom(page, 'left'))[0]
const ratioBefore = before.w / before.h
const ratioAfter = now.w / now.h
check(now.w > before.w + 20, 'corner drag resizes the photo', `w ${before.w.toFixed(0)} -> ${now.w.toFixed(0)}`)
check(Math.abs(ratioAfter - ratioBefore) < 0.02, 'photo resize stays aspect locked', `${ratioBefore.toFixed(3)} -> ${ratioAfter.toFixed(3)}`)
await shot(page, '21-resized')

// --- rotate + shift snap ---
const rot = page.locator('[data-handle="rotate"]')
hb = (await rot.boundingBox())!
await dragFromTo(page, { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, { x: hb.x + 90, y: hb.y + 40 })
await page.waitForTimeout(300)
now = (await pageGeom(page, 'left'))[0]
check(Math.abs(now.rot) > 5, 'rotate handle rotates the element', `${now.rot}deg`)

hb = (await rot.boundingBox())!
await dragFromTo(page, { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, { x: hb.x + 37, y: hb.y + 22 }, { modifier: 'Shift' })
await page.waitForTimeout(300)
now = (await pageGeom(page, 'left'))[0]
check(now.rot % 15 === 0, 'Shift snaps rotation to 15deg', `${now.rot}deg`)
await shot(page, '22-rotated')

// --- resize while rotated: the box must not jump on grab ---
const rotated = (await pageGeom(page, 'left'))[0]
const h11 = (await page.locator('[data-handle="corner-1-1"]').boundingBox())!
await page.mouse.move(h11.x + h11.width / 2, h11.y + h11.height / 2)
await page.mouse.down()
await page.mouse.move(h11.x + h11.width / 2 + 1, h11.y + h11.height / 2 + 1)
await page.waitForTimeout(120)
const grabbed = (await pageGeom(page, 'left'))[0]
await page.mouse.up()
const jump = Math.max(
  Math.abs(grabbed.x - rotated.x),
  Math.abs(grabbed.y - rotated.y),
  Math.abs(grabbed.w - rotated.w),
  Math.abs(grabbed.h - rotated.h),
)
check(jump < 20, 'grabbing a corner while rotated does not jump the box', `max delta ${jump.toFixed(1)} page units`)
await shot(page, '23-resize-rotated')

// --- snapping guide at the page centre ---
await page.keyboard.press('Escape')
await el.click()
const gb = await pageBox(page, 'left')
const eb2 = (await el.boundingBox())!
// Aim the element's centre at the page centre, a couple of units off.
const targetX = gb.x + (500 - 0 + 3) * gb.scale
const targetY = gb.y + (500 + 3) * gb.scale
await dragFromTo(page, { x: eb2.x + eb2.width / 2, y: eb2.y + eb2.height / 2 }, { x: targetX, y: targetY }, { steps: 18, hold: true })
await page.waitForTimeout(200)
const guides = await page.locator('[data-editable-page="left"] span.bg-primary\\/70').count()
check(guides > 0, 'a hairline guide appears near the page centre', `${guides} guides`)
await shot(page, '24-guides')
await page.mouse.up()
await page.waitForTimeout(200)
check((await page.locator('[data-editable-page="left"] span.bg-primary\\/70').count()) === 0, 'guides clear on release')

// Park the photo in the top-left quadrant so the caption never covers it.
{
  const gbx = await pageBox(page, 'left')
  const ebx = (await el.boundingBox())!
  await dragFromTo(
    page,
    { x: ebx.x + ebx.width / 2, y: ebx.y + ebx.height / 2 },
    { x: gbx.x + 260 * gbx.scale, y: gbx.y + 200 * gbx.scale },
  )
  await page.waitForTimeout(300)
}

// --- nudges ---
await el.click()
before = (await pageGeom(page, 'left'))[0]
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(150)
now = (await pageGeom(page, 'left'))[0]
check(Math.abs(now.x - before.x - 5) < 0.6, 'arrow nudges 5 units', `dx=${(now.x - before.x).toFixed(2)}`)
before = now
await page.keyboard.press('Shift+ArrowRight')
await page.waitForTimeout(150)
now = (await pageGeom(page, 'left'))[0]
check(Math.abs(now.x - before.x - 25) < 0.6, 'Shift-arrow nudges 25 units', `dx=${(now.x - before.x).toFixed(2)}`)

// --- Esc deselects ---
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
check((await page.locator('[data-handle="rotate"]').count()) === 0, 'Esc deselects')

// --- z-order with Cmd-] / Cmd-[ ---
await el.click()
await page.waitForTimeout(200)
await page.getByRole('button', { name: /add text/i }).click()
await page.waitForTimeout(300)
await page.keyboard.press('Meta+Enter')
await page.waitForTimeout(400)
const order = async () => (await pageGeom(page, 'left')).map((g) => g.id).join(',')
const o0 = await order()
const text = left.locator('[data-element]').last()
await text.click()
await page.waitForTimeout(250)
const selectedAfterCommit = (await page.locator('[data-handle="rotate"]').count()) > 0
check(selectedAfterCommit, 'a committed caption can be reselected')
await el.click()
await page.waitForTimeout(250)
const sel = await selectedId(page, 'left')
check(sel === o0.split(',')[0], 'clicking the lower photo selects it', `selected ${sel}, bottom ${o0.split(',')[0]}`)
await page.keyboard.down('Meta')
await page.keyboard.press('BracketRight')
await page.keyboard.up('Meta')
await page.waitForTimeout(300)
const o1 = await order()
check(o0 !== o1, 'one Cmd-] visibly raises the element above its page-mate', `${o0} -> ${o1}`)
await page.getByRole('button', { name: /bring forward/i }).click()
await page.waitForTimeout(300)
check((await order()) !== o0, 'toolbar Bring forward changes z-order', `${o0} -> ${await order()}`)
await page.getByRole('button', { name: /send backward/i }).click()
await page.waitForTimeout(300)
check((await order()) === o0, 'toolbar Send backward restores z-order')

// --- text editing ---
await text.dblclick()
await page.waitForTimeout(400)
const editable = await page.locator('[data-editable-page="left"] [contenteditable]').count()
check(editable === 1, 'double-click starts inline text editing', `${editable} editable nodes`)

// Fall back to the add-text path so the commit/cancel checks still run.
const startEditing = async () => {
  if ((await page.locator('[contenteditable]').count()) > 0) return
  await text.click()
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: /add text/i }).click()
  await page.waitForTimeout(300)
}
await startEditing()
await page.keyboard.press('Meta+A')
await page.keyboard.type('Hello coast')
await left.click({ position: { x: 12, y: 12 } })
await page.waitForTimeout(500)
check((await page.getByText('Hello coast').count()) > 0, 'blur commits the typed text')

const live = left.locator('[data-element]').last()
await live.click()
await page.waitForTimeout(200)
await page.getByRole('button', { name: /add text/i }).click()
await page.waitForTimeout(300)
await page.keyboard.press('Meta+A')
await page.keyboard.type('Discard me')
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
const storeText = await page.evaluate(() => document.body.innerText.includes('Discard me'))
check(!storeText, 'Esc cancels an inline text edit and clears it from the page', `still on screen: ${storeText}`)
await shot(page, '25-text')

// --- text controls ---
await text.click()
await page.waitForTimeout(200)
await page.getByRole('radio', { name: 'Clean' }).click().catch(async () => page.getByText('Clean', { exact: true }).click())
await page.waitForTimeout(200)
const font = await text.evaluate((n) => getComputedStyle(n).fontFamily)
check(!/caveat/i.test(font), 'font toggle switches to the clean face', font.slice(0, 40))
const swatch = page.getByRole('radio', { name: /oklch\(0.42/ }).first()
await swatch.click()
await page.waitForTimeout(200)
const colour = await text.evaluate((n) => getComputedStyle(n).color)
await page.getByRole('radio', { name: 'Align right' }).click().catch(() => undefined)
await page.waitForTimeout(200)
const align = await text.evaluate((n) => getComputedStyle(n).textAlign)
check(align === 'right', 'align control applies', align)
const slider = page.locator('[role="slider"]').first()
const fsBefore = await text.evaluate((n) => getComputedStyle(n).fontSize)
const posBefore = (await pageGeom(page, 'left')).at(-1)!.x
await slider.press('ArrowRight')
await slider.press('ArrowRight')
await page.waitForTimeout(300)
const fs = await text.evaluate((n) => getComputedStyle(n).fontSize)
const posAfter = (await pageGeom(page, 'left')).at(-1)!.x
check(fs !== fsBefore, 'the size slider changes the caption size with the keyboard', `${fsBefore} -> ${fs}`)
check(Math.abs(posAfter - posBefore) < 1, 'arrows on the size slider do not nudge the element instead', `x ${posBefore.toFixed(0)} -> ${posAfter.toFixed(0)}`)
check(colour !== 'rgb(0, 0, 0)', 'a colour swatch applies', colour)

// --- photo frames ---
await el.click()
await page.waitForTimeout(200)
for (const frame of ['polaroid', 'corners', 'tape', 'none']) {
  await page.getByRole('radio', { name: frame, exact: true }).click().catch(async () => {
    await page.getByText(frame, { exact: true }).click()
  })
  await page.waitForTimeout(250)
}
check(true, 'all four photo frames apply without error')
await shot(page, '26-frames')

// --- undo across one drag gesture = one step ---
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
const preDrag = (await pageGeom(page, 'left'))[0]
eb = (await el.boundingBox())!
await dragFromTo(page, { x: eb.x + eb.width / 2, y: eb.y + eb.height / 2 }, { x: eb.x + eb.width / 2 - 140, y: eb.y + eb.height / 2 })
await page.waitForTimeout(300)
const postDrag = (await pageGeom(page, 'left'))[0]
await page.keyboard.press('Escape')
await page.keyboard.press('Meta+z')
await page.waitForTimeout(300)
const undone = (await pageGeom(page, 'left'))[0]
check(
  Math.abs(undone.x - preDrag.x) < 2,
  'one undo reverts a whole drag gesture',
  `pre ${preDrag.x.toFixed(0)} post ${postDrag.x.toFixed(0)} undone ${undone.x.toFixed(0)}`,
)
await page.keyboard.press('Shift+Meta+z')
await page.waitForTimeout(300)
check(Math.abs((await pageGeom(page, 'left'))[0].x - postDrag.x) < 2, 'redo restores the drag')

// --- undo across a text edit ---
await page.getByRole('button', { name: /add text/i }).click()
await page.waitForTimeout(300)
await page.keyboard.type('Second caption')
await left.click({ position: { x: 12, y: 12 } })
await page.waitForTimeout(500)
const committed = await page.evaluate(() => document.body.innerText.includes('Second caption'))
await page.keyboard.press('Escape')
await page.keyboard.press('Meta+z')
await page.waitForTimeout(500)
const revertedText = await page.evaluate(() => document.body.innerText.includes('Second caption'))
check(committed && !revertedText, 'undo reverts a committed text edit', `committed=${committed}, after undo still there=${revertedText}`)
await page.keyboard.press('Shift+Meta+z')
await page.waitForTimeout(400)

// --- undo across insert / delete spread ---
const spreadCount = () => page.locator('[data-spread]').count()
await page.getByRole('button', { name: /insert spread after/i }).click()
await page.waitForTimeout(1500)
await page.keyboard.press('Meta+z')
await page.waitForTimeout(1500)
await page.getByRole('button', { name: /^pages$/i }).click()
await page.waitForTimeout(700)
const afterUndoInsert = await spreadCount()
check(afterUndoInsert === 1, 'undo removes an inserted spread', `${afterUndoInsert} spreads`)
await page.keyboard.press('Escape')
await page.waitForTimeout(700)
const onRealSpread = await left.isVisible().catch(() => false)
check(onRealSpread, 'undoing a spread insert leaves you on a real spread', `editable page visible=${onRealSpread}`)
if (!onRealSpread) {
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(1200)
}

// --- autosave reaches saved and survives a reload ---
await page.locator('[role="status"][data-status="saved"]').waitFor({ timeout: 25_000 })
check(true, 'autosave status reaches saved')
await clickUntil(page.getByRole('button', { name: /^edit$/i }), left).catch(() => undefined)
await page.waitForTimeout(600)
const leftBefore = await pageGeom(page, 'left')
const rightBefore = await pageGeom(page, 'right')
await page.goto(`${BASE}/albums/${id}`)
await clickUntil(page.getByRole('button', { name: /^edit$/i }), left)
await page.waitForTimeout(1200)
const leftAfter = await pageGeom(page, 'left')
const rightAfter = await pageGeom(page, 'right')
check(
  leftAfter.length === leftBefore.length && rightAfter.length === rightBefore.length,
  'a reload shows the same elements',
  `left ${leftBefore.length}->${leftAfter.length}, right ${rightBefore.length}->${rightAfter.length}`,
)
check(
  leftBefore[0] && leftAfter[0] && Math.abs(leftAfter[0].x - leftBefore[0].x) < 2,
  'reloaded geometry matches',
  `x ${leftBefore[0]?.x.toFixed(0)} -> ${leftAfter[0]?.x.toFixed(0)}`,
)
await shot(page, '27-reloaded')

// --- edit mode never parks on a cover ---
await page.keyboard.press('Home')
await page.waitForTimeout(1200)
check(await left.isVisible().catch(() => false), 'Home in edit mode stays on the first spread')
await page.keyboard.press('ArrowLeft')
await page.waitForTimeout(1000)
check(await left.isVisible().catch(() => false), 'ArrowLeft on the first spread does not open the cover')
await page.keyboard.press('End')
await page.waitForTimeout(1200)
check(await left.isVisible().catch(() => false), 'End in edit mode lands on the last spread, not the back cover')
const editableOnCover = await page.getByRole('button', { name: /add photo/i }).isDisabled()
check(!editableOnCover, 'the toolbar stays usable, because edit mode is always on a spread')

// Leaving edit mode, closing the book, then coming back jumps to a spread.
await page.getByRole('button', { name: /^done$/i }).first().click()
await page.waitForTimeout(500)
await page.keyboard.press('Home')
await page.waitForTimeout(1200)
check((await turnedIndex(page)) === 0, 'view mode still closes the book with Home', `turned=${await turnedIndex(page)}`)
await page.keyboard.press('e')
await page.waitForTimeout(1200)
check(
  await left.isVisible().catch(() => false),
  'entering edit mode from the cover jumps to the nearest spread',
)
await shot(page, '28-cover-edit')

console.log(`album: ${BASE}/albums/${id}`)
summary([p])
await browser.close()

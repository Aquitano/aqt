/** Phone layout for share + album, and a 12-photo drag/load performance smell. */
import {
  BASE,
  check,
  clickUntil,
  createAlbum,
  desktop,
  dragFromTo,
  launch,
  makeJpeg,
  pageGeom,
  probe,
  shot,
  signIn,
  summary,
  turnedIndex,
} from './lib'

const browser = await launch()
const ctx = await desktop(browser)
const page = await ctx.newPage()
const p = probe(page)

await signIn(page, 'qa_perf')
const id = await createAlbum(page, `Perf ${Date.now().toString(36)}`)
const left = page.locator('[data-editable-page="left"]')
await clickUntil(page.getByRole('button', { name: /^edit$/i }), left)

// --- 12 photos on one spread ---
await page.getByRole('button', { name: /add photo/i }).click()
const input = page.getByTestId('photo-input')
await input.waitFor({ state: 'attached' })
const files = await Promise.all(
  Array.from({ length: 12 }, async (_, i) => ({
    name: `p${i}.jpg`,
    mimeType: 'image/jpeg',
    buffer: await makeJpeg(page, 2000, 1500, i * 30),
  })),
)
await input.setInputFiles(files)
await page.waitForFunction(() => document.querySelectorAll('[data-testid="library-photo"]').length >= 12, undefined, { timeout: 180_000 })
for (let i = 0; i < 12; i++) {
  await page.getByTestId('library-photo').nth(i).click()
  await page.waitForTimeout(180)
}
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
const placed = (await pageGeom(page, 'left')).length + (await pageGeom(page, 'right')).length
check(placed === 12, 'twelve photos placed on one spread', `${placed}`)
await page.waitForTimeout(3000)
await shot(page, '50-twelve')

// --- drag smoothness: long-task time while dragging one of them ---
const el = left.locator('[data-element]').first()
const eb = (await el.boundingBox())!
const cdp = await ctx.newCDPSession(page)
await cdp.send('Performance.enable')
const readFrames = async () => {
  const { metrics } = await cdp.send('Performance.getMetrics')
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]))
  return { layout: m.LayoutDuration ?? 0, recalc: m.RecalcStyleDuration ?? 0, script: m.ScriptDuration ?? 0 }
}
await page.evaluate(() => {
  ;(window as unknown as { longTasks: number[] }).longTasks = []
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) (window as unknown as { longTasks: number[] }).longTasks.push(e.duration)
  }).observe({ entryTypes: ['longtask'] })
})
const m0 = await readFrames()
const t0 = Date.now()
await dragFromTo(page, { x: eb.x + eb.width / 2, y: eb.y + eb.height / 2 }, { x: eb.x + 220, y: eb.y + 160 }, { steps: 60 })
const dragMs = Date.now() - t0
const m1 = await readFrames()
const longTasks = await page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks)
const blocked = longTasks.reduce((a, b) => a + b, 0)
check(blocked < 300, 'dragging with 12 photos on the spread stays responsive', `${longTasks.length} long tasks, ${blocked.toFixed(0)}ms blocked over a ${dragMs}ms drag; script +${((m1.script - m0.script) * 1000).toFixed(0)}ms layout +${((m1.layout - m0.layout) * 1000).toFixed(0)}ms`)

// --- cold-ish load time ---
await page.waitForTimeout(3000)
const fresh = await ctx.newPage()
const t1 = Date.now()
await fresh.goto(`${BASE}/albums/${id}`, { waitUntil: 'load' })
await fresh.locator('[data-sheet]').first().waitFor({ timeout: 20_000 })
const loadMs = Date.now() - t1
check(loadMs < 2000, 'the album loads in under 2s locally', `${loadMs}ms`)
await shot(fresh, '51-loaded')
await fresh.close()

// --- share link for the phone tests ---
await page.getByRole('button', { name: /^done$/i }).first().click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: 'Share', exact: true }).click()
await page.getByRole('switch').click()
await page.getByTestId('share-url').waitFor({ timeout: 15_000 })
const url = await page.getByTestId('share-url').inputValue()

// --- phone: share view ---
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const small = await phone.newPage()
const sp = probe(small)
await small.goto(url)
await small.locator('[data-sheet]').first().waitFor({ timeout: 20_000 })
const box = await small.evaluate(() => {
  const b = document.querySelector('[data-sheet]')!.parentElement!.getBoundingClientRect()
  return { x: b.x, y: b.y, w: b.width, h: b.height }
})
check(box.w < 390 && Math.abs(box.w - box.h) < 4, 'phone share view is a single square page', `${Math.round(box.w)}x${Math.round(box.h)}`)
await shot(small, '52-phone-share')

const t = await turnedIndex(small)
await dragFromTo(small, { x: box.x + box.w * 0.95, y: box.y + box.h / 2 }, { x: box.x - box.w * 0.5, y: box.y + box.h / 2 }, { steps: 20 })
await small.waitForTimeout(1200)
check((await turnedIndex(small)) === t + 1, 'phone share view turns by drag', `${t} -> ${await turnedIndex(small)}`)
await shot(small, '53-phone-turned')

// --- phone: own album hides editing ---
await signIn(small, 'qa_perf')
await small.goto(`${BASE}/albums/${id}`)
await small.waitForTimeout(1500)
const editVisible = await small.getByRole('button', { name: /^edit$/i }).isVisible().catch(() => false)
check(!editVisible, 'the phone album page hides the Edit toggle')
const shareVisible = await small.getByRole('button', { name: 'Share', exact: true }).isVisible().catch(() => false)
check(!shareVisible, 'the phone album page hides sharing controls', `visible=${shareVisible}`)
await shot(small, '54-phone-album')

summary([p, sp])
await browser.close()

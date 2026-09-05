/** Sharing, share-link lifecycle, cross-user access, photo API auth. */
import { BASE, check, clickUntil, createAlbum, desktop, launch, makeJpeg, probe, shot, signIn, summary, turnedIndex } from './lib'

const browser = await launch()
const ctx = await desktop(browser)
const page = await ctx.newPage()
const p = probe(page)

await signIn(page, 'qa_share')
const id = await createAlbum(page, `Album ${Date.now().toString(36)}`)
const left = page.locator('[data-editable-page="left"]')
await clickUntil(page.getByRole('button', { name: /^edit$/i }), left)

// A photo so the share view has something to show and an id to probe.
await page.getByRole('button', { name: /add photo/i }).click()
const input = page.getByTestId('photo-input')
await input.waitFor({ state: 'attached' })
await input.setInputFiles({ name: 's.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(page, 1200, 900, 60) })
await page.getByTestId('library-photo').first().waitFor({ timeout: 40_000 })
await page.getByTestId('library-photo').first().click()
await left.locator('[data-element]').first().waitFor({ timeout: 10_000 })
const photoId = await page.evaluate(
  () => new URL(document.querySelector<HTMLImageElement>('[data-editable-page="left"] img')!.src).pathname.split('/').pop()!,
)
await page.keyboard.press('Escape')
await page.waitForTimeout(3000)
await page.getByRole('button', { name: /^done$/i }).first().click()
await page.waitForTimeout(500)

// --- enable sharing ---
await page.getByRole('button', { name: 'Share', exact: true }).click()
await page.getByRole('switch').click()
await page.getByTestId('share-url').waitFor({ timeout: 15_000 })
const url = await page.getByTestId('share-url').inputValue()
check(/\/s\/[A-Za-z0-9_-]+$/.test(url), 'enabling sharing yields a /s/<slug> link', url)
await page.getByRole('button', { name: /copy link/i }).click()
await page.waitForTimeout(600)
const copyToast = (await page.locator('[data-sonner-toast]').allInnerTexts()).join(' ')
check(/copied/i.test(copyToast), 'copy link confirms', copyToast.replace(/\n/g, ' ').slice(0, 80))
await shot(page, '40-share')

// A browser that refuses the clipboard must say so, not fail silently.
await page.evaluate(() => {
  Object.defineProperty(navigator.clipboard, 'writeText', {
    configurable: true,
    value: () => Promise.reject(new Error('denied')),
  })
})
await page.getByRole('button', { name: /copy link/i }).click()
await page.waitForTimeout(800)
const refusedToast = (await page.locator('[data-sonner-toast]').allInnerTexts()).join(' ')
check(/could not copy/i.test(refusedToast), 'a refused clipboard write is reported', refusedToast.replace(/\n/g, ' ').slice(0, 90))

// --- signed-out visitor ---
const guest = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const view = await guest.newPage()
const gp = probe(view)
await view.goto(url)
await view.locator('[data-sheet]').first().waitFor({ timeout: 20_000 })
check((await turnedIndex(view)) === 0, 'the share link opens on the closed cover')
await view.keyboard.press('ArrowRight')
await view.keyboard.press('ArrowRight')
await view.waitForTimeout(1400)
check((await turnedIndex(view)) === 2, 'a signed-out visitor can turn pages', `turned=${await turnedIndex(view)}`)
const affordances = await view.evaluate(() => ({
  edit: document.querySelectorAll('button').length,
  labels: [...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim()).filter(Boolean),
}))
const editish = affordances.labels.filter((l) => /edit|add photo|add text|delete|share|insert spread|pages|undo|redo/i.test(String(l)))
check(editish.length === 0, 'the share view exposes no edit affordances', JSON.stringify(editish))
await shot(view, '41-shared')

// --- the photo API from a signed-out context ---
const api = await view.evaluate(async (pid) => {
  const get = await fetch(`/api/photos/${pid}`)
  const put = await fetch(`/api/photos/${pid}`, { method: 'PUT', body: 'x' })
  return { get: get.status, put: put.status }
}, photoId)
check(api.get === 200, 'GET /api/photos/:id works signed out for a shared album', `${api.get}`)
check(api.put === 401, 'PUT /api/photos/:id is 401 signed out', `${api.put}`)

// --- unknown slug ---
const missing = await view.goto(`${BASE}/s/doesnotexist`)
await view.waitForTimeout(800)
const missingBody = await view.evaluate(() => document.body.innerText.slice(0, 120))
check(missing?.status() === 404, '/s/doesnotexist returns a 404 status', `HTTP ${missing?.status()}`)
check(/not available/i.test(missingBody), '/s/doesnotexist shows the not-found page', missingBody.replace(/\n/g, ' ').slice(0, 80))
await shot(view, '42-unknown-slug')

// --- disable sharing, then reload the link ---
await page.getByRole('switch').click()
await page.waitForTimeout(2000)
const revoked = await view.goto(url)
await view.waitForTimeout(900)
const revokedBody = await view.evaluate(() => document.body.innerText.slice(0, 160))
check(revoked?.status() === 404, 'a disabled share link 404s', `HTTP ${revoked?.status()}`)
check(/not available/i.test(revokedBody), 'a disabled share link shows the not-found page', revokedBody.replace(/\n/g, ' ').slice(0, 80))
await shot(view, '43-revoked')

// The photo behind a revoked link is still readable.
const afterRevoke = await view.evaluate(async (pid) => (await fetch(`/api/photos/${pid}`)).status, photoId)
check(afterRevoke === 404 || afterRevoke === 403, 'photos stop being readable once sharing is off', `GET ${afterRevoke}`)

// --- another user's album ---
const other = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const op = await other.newPage()
const opp = probe(op)
await signIn(op, `qa_other_${Date.now().toString(36)}`)
const res = await op.goto(`${BASE}/albums/${id}`)
await op.waitForTimeout(1200)
const otherBody = await op.evaluate(() => document.body.innerText.slice(0, 200))
check(!/Share /.test(otherBody), "another user's album is not shown", otherBody.replace(/\n/g, ' ').slice(0, 100))
check((res?.status() ?? 0) >= 400, "another user's album returns an error status", `HTTP ${res?.status()}`)
check(/not available/i.test(otherBody), "another user's album shows the not-found page", otherBody.replace(/\n/g, ' ').slice(0, 100))
check(
  opp.errors.every((e) => !/Invariant failed/i.test(e)),
  "another user's album does not blow up the router",
  opp.errors.filter((e) => /Invariant/i.test(e)).join(' | ').slice(0, 140),
)
await shot(op, '44-other-user')

// A signed-in stranger reading someone else's photo.
const strangerPhoto = await op.evaluate(async (pid) => (await fetch(`/api/photos/${pid}`)).status, photoId)
check(strangerPhoto !== 200, "a stranger cannot read another user's photo bytes", `GET ${strangerPhoto}`)

summary([p, gp, opp])
await browser.close()

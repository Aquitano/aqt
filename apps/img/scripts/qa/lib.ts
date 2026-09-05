/**
 * Shared harness for the independent QA scripts in scripts/qa/.
 * Sign-in mirrors scripts/e2e-smoke.ts: a Backend-API test user + __clerk_ticket.
 */
import { mkdir } from 'node:fs/promises'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'

export const BASE = process.env.QA_BASE ?? 'http://localhost:3000'
export const OUT = 'scripts/qa/out'
const USERNAME = 'smoke_test'

export type Probe = { errors: string[]; requests: string[] }

export async function launch() {
  await mkdir(OUT, { recursive: true })
  return chromium.launch()
}

/** Attaches console-error / pageerror / failed-request capture to a page. */
export function probe(page: Page): Probe {
  const errors: string[] = []
  const requests: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  page.on('requestfailed', (r) => requests.push(`failed ${r.method()} ${r.url()}: ${r.failure()?.errorText}`))
  page.on('response', (r) => {
    if (r.status() >= 400) requests.push(`${r.status()} ${r.request().method()} ${r.url()}`)
  })
  return { errors, requests }
}

async function clerk<T>(path: string, body?: object): Promise<T> {
  const secret = process.env.CLERK_SECRET_KEY
  if (!secret) throw new Error('CLERK_SECRET_KEY missing')
  const res = await fetch(`https://api.clerk.com/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`Clerk ${path}: ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

/** Creates or reuses a Clerk user and returns its id. */
export async function testUser(username = USERNAME) {
  type User = { id: string }
  const [existing] = await clerk<User[]>(`/users?username=${username}&limit=1`)
  return existing ?? (await clerk<User>('/users', { username, password: `Album-qa-${username}-1234` }))
}

export async function signIn(page: Page, username = USERNAME) {
  const user = await testUser(username)
  const { token } = await clerk<{ token: string }>('/sign_in_tokens', {
    user_id: user.id,
    expires_in_seconds: 300,
  })
  await page.goto(`${BASE}/?__clerk_ticket=${token}`)
  await page.waitForURL(/\/albums/, { timeout: 30_000 })
  return user.id
}

export async function desktop(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
}

export const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png` })

const results: string[] = []
export function check(ok: boolean, label: string, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
export function summary(probes: Probe[]) {
  const errors = probes.flatMap((p) => p.errors)
  const requests = probes.flatMap((p) => p.requests)
  console.log('\n=== summary ===')
  for (const r of results) console.log(r)
  if (errors.length) console.log(`\nconsole/page errors:\n${[...new Set(errors)].join('\n')}`)
  if (requests.length) console.log(`\nbad responses:\n${[...new Set(requests)].join('\n')}`)
  if (!errors.length && !requests.length) console.log('\nno console errors, no >=400 responses')
}

/** Makes a JPEG of the given size inside the page and returns it as a Buffer. */
export async function makeJpeg(page: Page, w: number, h: number, hue = 30) {
  const base64 = await page.evaluate(
    async ([width, height, tone]) => {
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext('2d')!
      const g = ctx.createLinearGradient(0, 0, width, height)
      g.addColorStop(0, `hsl(${tone} 60% 60%)`)
      g.addColorStop(1, `hsl(${(tone + 140) % 360} 50% 40%)`)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, width, height)
      ctx.fillStyle = '#fff6'
      ctx.beginPath()
      ctx.arc(width * 0.7, height * 0.3, Math.min(width, height) * 0.2, 0, Math.PI * 2)
      ctx.fill()
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (const b of bytes) s += String.fromCharCode(b)
      return btoa(s)
    },
    [w, h, hue] as const,
  )
  return Buffer.from(base64, 'base64')
}

/** Pointer drag with intermediate moves so pointermove handlers fire. */
export async function dragFromTo(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { steps?: number; hold?: boolean; modifier?: 'Shift' } = {},
) {
  const steps = opts.steps ?? 14
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  if (opts.modifier) await page.keyboard.down(opts.modifier)
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
  }
  if (!opts.hold) {
    if (opts.modifier) await page.keyboard.up(opts.modifier)
    await page.mouse.up()
  }
}

/** Clicks until a target appears; the SSR HTML is clickable before hydration. */
export async function clickUntil(trigger: Locator, target: Locator, tries = 12) {
  for (let i = 0; i < tries; i++) {
    if (await target.isVisible().catch(() => false)) return
    await trigger.click({ timeout: 5000 }).catch(() => undefined)
    await target.waitFor({ timeout: 1000 }).catch(() => undefined)
  }
  await target.waitFor({ timeout: 5000 })
}

/**
 * Reads each mounted leaf's rotateY. Sheets before the turn point sit at -180,
 * the rest at 0, so this gives both the animation state and the turn index.
 */
export async function sheetAngles(page: Page): Promise<Record<number, number>> {
  return page.evaluate(() => {
    const out: Record<number, number> = {}
    for (const el of document.querySelectorAll<HTMLElement>('[data-sheet]')) {
      const m = new DOMMatrix(getComputedStyle(el).transform)
      out[Number(el.dataset.sheet)] = Math.round((Math.atan2(-m.m13, m.m11) * 180) / Math.PI)
    }
    return out
  })
}

/** Turn index: the lowest mounted sheet still lying on the right stack. */
export async function turnedIndex(page: Page) {
  const angles = await sheetAngles(page)
  const entries = Object.entries(angles).map(([s, a]) => [Number(s), a] as const)
  const upright = entries.filter(([, a]) => Math.abs(a) < 90).map(([s]) => s)
  if (upright.length) return Math.min(...upright)
  return Math.max(...entries.map(([s]) => s)) + 1
}

/** Creates an album through the UI and returns its id. */
export async function createAlbum(page: Page, title: string, material = 'linen') {
  await page.getByRole('button', { name: /new album/i }).click()
  await page.getByLabel('Title').fill(title)
  await page.getByRole('dialog').getByText(material, { exact: true }).click()
  await page.getByRole('button', { name: /^create$/i }).click()
  const link = page.getByRole('link', { name: new RegExp(title) }).first()
  await link.waitFor({ timeout: 15_000 })
  await link.click()
  await page.waitForURL(/\/albums\/[^/]+$/)
  await page.locator('[data-sheet]').first().waitFor()
  return page.url().split('/').pop()!
}

export type Geom = { id: string; x: number; y: number; w: number; h: number; rot: number }

/** Element boxes of one editable page, converted back into page units. */
export async function pageGeom(page: Page, side: 'left' | 'right'): Promise<Geom[]> {
  return page.evaluate((s) => {
    const root = document.querySelector<HTMLElement>(`[data-editable-page="${s}"]`)
    if (!root) return []
    const scale = root.getBoundingClientRect().width / 1000
    return [...root.querySelectorAll<HTMLElement>('[data-element]')].map((el) => {
      const style = getComputedStyle(el)
      const m = new DOMMatrix(style.transform)
      // offsetLeft/Top round to whole pixels, which is coarser than a 5-unit nudge.
      return {
        id: el.dataset.element!,
        x: parseFloat(style.left) / scale,
        y: parseFloat(style.top) / scale,
        w: el.offsetWidth / scale,
        h: el.offsetHeight / scale,
        rot: Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI),
      }
    })
  }, side)
}

/** Centre of an editable page in client coordinates, plus its scale. */
export async function pageBox(page: Page, side: 'left' | 'right') {
  return page.evaluate((s) => {
    const r = document.querySelector<HTMLElement>(`[data-editable-page="${s}"]`)!.getBoundingClientRect()
    return { x: r.x, y: r.y, size: r.width, scale: r.width / 1000 }
  }, side)
}

/** Id of the selected element, matched by the TransformBox's position. */
export async function selectedId(page: Page, side: 'left' | 'right') {
  return page.evaluate((s) => {
    const root = document.querySelector<HTMLElement>(`[data-editable-page="${s}"]`)
    const handle = root?.querySelector<HTMLElement>('[data-handle="rotate"]')
    if (!root || !handle) return null
    const boxEl = handle.parentElement!
    const b = boxEl.getBoundingClientRect()
    let best: { id: string; d: number } | null = null
    for (const el of root.querySelectorAll<HTMLElement>('[data-element]')) {
      const r = el.getBoundingClientRect()
      const d = Math.abs(r.x - b.x) + Math.abs(r.y - b.y) + Math.abs(r.width - b.width)
      if (!best || d < best.d) best = { id: el.dataset.element!, d }
    }
    return best?.id ?? null
  }, side)
}

export const center = (b: { x: number; y: number; width: number; height: number }) => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
})

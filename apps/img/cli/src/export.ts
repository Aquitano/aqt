import { chromium } from "playwright";

import type { Client } from "./client";

/**
 * Prints `/print/:albumId` to a PDF with headless Chromium. The page sizes
 * come from its own @page rules, so the PDF has one page per spread.
 */
export async function exportPdf(client: Client, albumId: string, out?: string) {
  const { album } = await client.albums.get(albumId);
  const file = out ?? `${slug(album.title) || album.id}.pdf`;

  const browser = await launchChromium();
  try {
    const context = await browser.newContext({ extraHTTPHeaders: client.headers });
    const page = await context.newPage();
    await page.goto(`${client.url}/print/${albumId}`, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-print-root]");
    await page.evaluate(() => document.fonts.ready);
    await page.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.close();
  }
  return file;
}

/** Chromium is downloaded separately, so a missing one gets its own hint. */
async function launchChromium() {
  try {
    return await chromium.launch();
  } catch (cause) {
    throw new Error(
      `Could not start Chromium. Run \`bunx playwright install chromium\` once.\n${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

function slug(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

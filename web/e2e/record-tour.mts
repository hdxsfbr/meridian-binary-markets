/**
 * Tour scenes for the showcase cut (no transactions): landing hero, Markets
 * board, Trade page tour on an open market, Docs. Each scene is one WebM in
 * OUT_DIR, named so it sorts between record-demo.mts's scenes:
 *   02a-landing, 02b-markets, 02c-trade, 06b-docs
 * Run inside the dev container (see record-demo.mts for the docker exec shape):
 *   -e TICKER=BTC -e STRIKE=83400 -e MAKER=<b58> -e OUT_DIR=/work/design/demo
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT = process.env.OUT_DIR ?? "/work/design/demo";
const TICKER = process.env.TICKER ?? "BTC";
const STRIKE = process.env.STRIKE ?? "83400";
const MAKER = process.env.MAKER ?? "";
const VIEWPORT = { width: 1440, height: 900 };
mkdirSync(join(OUT, "raw"), { recursive: true });

async function scene(browser: Browser, name: string, secret: string | undefined, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: join(OUT, "raw"), size: VIEWPORT } });
  const page = await context.newPage();
  if (secret) {
    await page.addInitScript((s: string) => {
      (window as unknown as { __MERIDIAN_E2E_SECRET__?: string }).__MERIDIAN_E2E_SECRET__ = s;
    }, secret);
  }
  await run(page);
  const video = page.video();
  await context.close();
  if (video) {
    renameSync(await video.path(), join(OUT, `${name}.webm`));
    console.log("scene", name);
  }
}

async function glide(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 40, ms = 40): Promise<void> {
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await page.waitForTimeout(ms);
  }
}

async function slowScroll(page: Page, px: number, steps = 16): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, px / steps);
    await page.waitForTimeout(110);
  }
}

const browser = await chromium.launch();

// Landing: let the hero cycle through two assets and the chart redraw, then scroll the page.
await scene(browser, "02a-landing", undefined, async (page) => {
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForTimeout(14000);
  await slowScroll(page, 900);
  await page.waitForTimeout(3500);
  await slowScroll(page, 900);
  await page.waitForTimeout(3500);
});

// Markets: the board, hover a card, expand one ladder.
await scene(browser, "02b-markets", undefined, async (page) => {
  await page.goto(`${BASE}/markets`, { waitUntil: "load" });
  await page.waitForTimeout(5000);
  const card = page.getByTestId(`ticker-card-${TICKER}`).first();
  if (await card.count()) {
    const box = await card.boundingBox();
    if (box) await glide(page, { x: 300, y: 500 }, { x: box.x + box.width / 2, y: box.y + 40 });
  }
  await page.waitForTimeout(1500);
  const more = page.getByRole("button", { name: /more strike/ }).first();
  if (await more.count()) {
    await more.click();
    await page.waitForTimeout(3500);
  }
  await page.waitForTimeout(2000);
});

// Trade: chart crosshair sweep, strike selection, order book toggle, trade panel estimate.
await scene(browser, "02c-trade", MAKER || undefined, async (page) => {
  await page.goto(`${BASE}/trade/${TICKER}?strike=${STRIKE}`, { waitUntil: "load" });
  await page.waitForTimeout(6000);
  // Sweep the crosshair across the chart (chart box sits under the "Price history" heading).
  const chart = page.locator("canvas").first();
  const cb = await chart.boundingBox();
  if (cb) {
    await glide(page, { x: cb.x + 20, y: cb.y + cb.height / 2 }, { x: cb.x + cb.width - 80, y: cb.y + cb.height / 2 }, 60, 50);
    await page.waitForTimeout(1200);
  }
  // Walk the strikes: click the row above and below, then back.
  // Strike rows are role="row" elements (not a <table>); skip the header by requiring a $ amount.
  const rows = page.getByRole("row").filter({ hasText: /\$\d/ });
  const n = await rows.count();
  for (const i of [0, Math.min(1, n - 1), Math.min(2, n - 1)]) {
    if (n === 0) break;
    await rows.nth(i).click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2200);
  }
  // Order book: flip to the No perspective and back.
  const noBtn = page.getByRole("button", { name: "No", exact: true }).first();
  // (order-book perspective toggle)
  if (await noBtn.count()) {
    await noBtn.click();
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "Yes", exact: true }).first().click();
    await page.waitForTimeout(1500);
  }
  // Trade panel: quantity presets change the "You pay" line (no order is sent).
  for (const q of ["5", "10", "1"]) {
    const chip = page.getByRole("button", { name: q, exact: true }).first();
    if (await chip.count()) {
      await chip.click();
      await page.waitForTimeout(1600);
    }
  }
  await page.waitForTimeout(1500);
});

// Docs: the in-app documentation, one page scrolled.
await scene(browser, "06b-docs", undefined, async (page) => {
  await page.goto(`${BASE}/docs/how-contracts-work`, { waitUntil: "load" });
  await page.waitForTimeout(3500);
  await slowScroll(page, 700);
  await page.waitForTimeout(3000);
  await page.goto(`${BASE}/docs/settlement-and-redemption`, { waitUntil: "load" });
  await page.waitForTimeout(4500);
});

await browser.close();
console.log("tour recorded to", OUT);

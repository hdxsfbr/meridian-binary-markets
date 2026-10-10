/**
 * Tour scenes for the showcase cut (no transactions): landing hero, Markets
 * board, Trade page tour on an open market, Docs. Each scene is one WebM in
 * OUT_DIR, named so it sorts between record-demo.mts's scenes:
 *   02a-landing, 02b-markets, 02c-trade, 06c-portfolio, 06d-admin, 08b-docs, 08c/08d/08e tech cards
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
const ONLY = (process.env.SCENES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
mkdirSync(join(OUT, "raw"), { recursive: true });

async function scene(browser: Browser, name: string, secret: string | undefined, run: (page: Page) => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.some((o) => name.startsWith(o))) return;
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
  await page.waitForTimeout(4000);
  if (MAKER) {
    await page.getByRole("button", { name: "Select Wallet", exact: true }).click({ timeout: 5000 }).catch(() => {});
    await page.getByRole("button", { name: /^Test Wallet/ }).click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }
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
    await noBtn.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "Yes", exact: true }).first().click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  // Trade panel: quantity presets change the "You pay" line (no order is sent).
  for (const q of ["5", "10", "1"]) {
    const chip = page.getByRole("button", { name: q, exact: true }).first();
    if (await chip.count()) {
      await chip.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(1600);
    }
  }
  await page.waitForTimeout(1500);
});

// Docs: the in-app documentation, one page scrolled.
await scene(browser, "08b-docs", undefined, async (page) => {
  await page.goto(`${BASE}/docs/how-contracts-work`, { waitUntil: "load" });
  await page.waitForTimeout(3500);
  await slowScroll(page, 700);
  await page.waitForTimeout(3000);
  await page.goto(`${BASE}/docs/settlement-and-redemption`, { waitUntil: "load" });
  await page.waitForTimeout(4500);
});


const ADMIN = process.env.ADMIN ?? "";

function bulletCardHtml(title: string, bullets: string[]): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0b1026;color:#f1f5f9;font-family:Inter,system-ui,sans-serif}
    .wrap{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 160px;gap:22px}
    .rule{width:96px;height:4px;border-radius:999px;background:linear-gradient(90deg,#a855f7,#6366f1,#22d3ee)}
    h1{font-size:44px;font-weight:600;margin:0;letter-spacing:-0.01em}
    ul{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:14px}
    li{font-size:24px;color:#cbd5e1;line-height:1.4;padding-left:28px;position:relative;opacity:0;animation:in .5s ease-out forwards}
    li::before{content:"";position:absolute;left:0;top:14px;width:10px;height:10px;border-radius:999px;background:#22d3ee}
    li:nth-child(1){animation-delay:.4s}li:nth-child(2){animation-delay:1.4s}li:nth-child(3){animation-delay:2.4s}li:nth-child(4){animation-delay:3.4s}
    @keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    .brand{position:absolute;bottom:40px;left:160px;font-size:18px;color:#64748b;letter-spacing:.2em}
  </style></head><body><div class="wrap"><div class="rule"></div><h1>${title}</h1><ul>${bullets.map((b) => `<li>${b}</li>`).join("")}</ul></div>
  <div class="brand">MERIDIAN · UNDER THE HOOD</div></body></html>`;
}

// Portfolio tour with the maker wallet: stat tiles, positions, quotes, open orders.
await scene(browser, "06c-portfolio", MAKER || undefined, async (page) => {
  await page.goto(`${BASE}/portfolio`, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Select Wallet", exact: true }).click({ timeout: 5000 }).catch(() => {});
  await page.getByRole("button", { name: /^Test Wallet/ }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(7000);
  await slowScroll(page, 500, 12);
  await page.waitForTimeout(3500);
  await slowScroll(page, 700, 14);
  await page.waitForTimeout(4000);
  await slowScroll(page, 700, 14);
  await page.waitForTimeout(3500);
});

// Operator view with the admin wallet: config, settlement checks, unsettled table, add strike.
await scene(browser, "06d-admin", ADMIN || undefined, async (page) => {
  await page.goto(`${BASE}/admin`, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Select Wallet", exact: true }).click({ timeout: 5000 }).catch(() => {});
  await page.getByRole("button", { name: /^Test Wallet/ }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(6000);
  const checks = page.getByText("Settlement checks", { exact: true }).first();
  if (await checks.count()) {
    await checks.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }
  await slowScroll(page, 600, 12);
  await page.waitForTimeout(4500);
});

const techCards: Array<[string, string, string[]]> = [
  ["08c-tech-program", "Under the hood: the program", [
    "Anchor program on Solana; every market is a Yes/No pair backed by $1.00 in a program-owned vault",
    "One order book per strike; Buy No and Sell No are routed through the same Yes book",
    "Trading stops at the close by rule, not by the UI; the $1.00 invariant is enforced on chain",
    "287 program tests, end-to-end lifecycle on a local validator, reviewed by a second model before every merge",
  ]],
  ["08d-tech-tokens", "Under the hood: tokens and settlement", [
    "Token-2022 mints with on-chain names: wallets show “AAPL ≥ $340 Yes Oct 10”, not “Unknown Token”",
    "Mints close once empty, so a day’s rent comes back and keys can be reused",
    "Pyth close posted on chain and checked for freshness, confidence and publish time before settling",
    "Operator override only after a delay, and visible on chain as an override",
  ]],
  ["08e-tech-ops", "Under the hood: operations", [
    "Worker on Railway: morning ladders, intraday strike extension, settlement at 4:00:30 PM ET, nightly reclaim",
    "Event index served by the worker: Portfolio and History load in seconds, not minutes",
    "Public site on Railway, Docker-only toolchain, docs and decision log in the repo",
    "Two unattended settlement days on devnet so far; this one, live, on a Saturday",
  ]],
];
for (const [name, title, bullets] of techCards) {
  await scene(browser, name, undefined, async (page) => {
    await page.setContent(bulletCardHtml(title, bullets));
    await page.waitForTimeout(14000);
  });
}

await browser.close();
console.log("tour recorded to", OUT);

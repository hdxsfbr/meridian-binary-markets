/**
 * Demo recording harness (docs/demo-script.md). Drives the app in a real
 * browser against the cluster the dev server points at and records one WebM
 * per scene, with an HTML title card before each. The scenes follow the PRD's
 * lifecycle: markets → mint and quote (maker) → buy (taker) → close → settle
 * (run by the operator outside the browser between scenes) → redeem.
 *
 * Run inside the dev container against the NEXT_PUBLIC_E2E dev server:
 *   docker exec -e MAKER="$(cat /tmp/usera.b58)" -e TAKER="$(cat /tmp/userb.b58)" \
 *     -e TICKER=BTC -e STRIKE=100000 -e PHASE=pre \
 *     -e PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers -w /work/web meridian-web-devnet-e2e \
 *     /work/scripts/node_modules/.bin/tsx e2e/record-demo.mts
 *
 * PHASE=pre records scenes 1-5 (up to the close); PHASE=post records scenes
 * 6-8 after the settle job has run. OUT_DIR defaults to /work/design/demo.
 * Secrets arrive via env and are injected into the page the same way the
 * Playwright specs do (web/src/lib/e2e-wallet.ts); nothing is written to disk.
 */

import { chromium, type Browser, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT = process.env.OUT_DIR ?? "/work/design/demo";
const TICKER = process.env.TICKER ?? "BTC";
const STRIKE = process.env.STRIKE ?? "100000";
const PHASE = process.env.PHASE ?? "pre";
const MAKER = process.env.MAKER ?? "";
const TAKER = process.env.TAKER ?? "";
const VIEWPORT = { width: 1440, height: 900 };
/** SCENES=04-maker,06-taker records only those scenes (prefix match); empty records the whole phase. */
const ONLY = (process.env.SCENES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const want = (name: string): boolean => ONLY.length === 0 || ONLY.some((o) => name.startsWith(o));
const ASK = process.env.ASK ?? "0.55";
const BID = process.env.BID ?? "0.45";
const QTY = process.env.QTY ?? "3";

mkdirSync(OUT, { recursive: true });

/**
 * Confirmation waits (devnet can take 20-60 s to confirm) are recorded in full and
 * then cut out in post by web/e2e/cut-waits.sh: every `skip()` block records the
 * footage interval it covered, relative to the scene's recording start, into
 * <OUT>/cuts.json. The click and the first second of the pending state stay in;
 * the footage resumes just before the confirmation toast lands.
 */
const cuts: Record<string, Array<[number, number]>> = {};
const sceneStart = new WeakMap<Page, number>();
const KEEP_AFTER_CLICK = 1.2;
const RESUME_BEFORE_TOAST = 0.3;
async function skip(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = sceneStart.get(page) ?? Date.now();
  const from = (Date.now() - t0) / 1000 + KEEP_AFTER_CLICK;
  await fn();
  const to = (Date.now() - t0) / 1000 - RESUME_BEFORE_TOAST;
  if (to > from + 0.5) (cuts[name] ??= []).push([Number(from.toFixed(2)), Number(to.toFixed(2))]);
}

function titleCardHtml(title: string, subtitle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0b1026;color:#f1f5f9;font-family:Inter,system-ui,sans-serif}
    .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}
    .logo{height:56px;margin-bottom:10px}
    .rule{width:96px;height:4px;border-radius:999px;background:linear-gradient(90deg,#a855f7,#6366f1,#22d3ee)}
    h1{font-size:56px;font-weight:600;margin:0;letter-spacing:-0.01em}
    p{font-size:24px;color:#94a3b8;margin:0;max-width:900px;text-align:center;line-height:1.4}
    .brand{position:absolute;bottom:40px;left:0;right:0;text-align:center;font-size:18px;color:#64748b;letter-spacing:.2em}
  </style></head><body><div class="wrap"><img class="logo" src="${BASE}/brand/logo-dark.svg" alt=""><div class="rule"></div><h1>${title}</h1><p>${subtitle}</p></div>
  <div class="brand">MERIDIAN · SOLANA DEVNET</div></body></html>`;
}

async function newPage(browser: Browser, name: string, secret?: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: join(OUT, "raw"), size: VIEWPORT },
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  sceneStart.set(page, Date.now());
  if (secret) {
    await page.addInitScript((s: string) => {
      (window as unknown as { __MERIDIAN_E2E_SECRET__?: string }).__MERIDIAN_E2E_SECRET__ = s;
    }, secret);
  }
  (page as unknown as { __name: string }).__name = name;
  return page;
}

async function finish(page: Page, name: string): Promise<void> {
  const video = page.video();
  await page.context().close();
  if (video) {
    const path = await video.path();
    const target = join(OUT, `${name}.webm`);
    const { renameSync } = await import("node:fs");
    renameSync(path, target);
    console.log("scene", name, "->", target);
  }
}

/**
 * Title cards are rendered as stills (<name>.png), not recorded: a recorded card
 * sometimes came out as a blank one-second clip, and a still is exactly what the
 * stitch/mux scripts need anyway (they hold it for the narration's length, or
 * `seconds` when there is no narration, written to <name>.seconds).
 */
async function card(browser: Browser, name: string, title: string, subtitle: string, seconds = 3): Promise<void> {
  if (!want(name)) return;
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.setContent(titleCardHtml(title, subtitle), { waitUntil: "load" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  writeFileSync(join(OUT, `${name}.seconds`), String(seconds));
  await context.close();
  console.log("card", name);
}

async function connect(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Select Wallet", exact: true }).click();
  await page.getByRole("button", { name: /^Test Wallet/ }).click();
  await page.waitForTimeout(1500);
}

async function slowScroll(page: Page, px: number, steps = 12): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, px / steps);
    await page.waitForTimeout(120);
  }
}

/** Portfolio shows "Updating your trade history…" / "Cost basis updating…" until the event index is merged; wait it out (the wait is cut from the footage). */
async function waitForHistory(page: Page, name: string): Promise<void> {
  await skip(page, name, async () => {
    for (let i = 0; i < 45; i += 1) {
      const pending = await page.getByText(/Updating your trade history|Cost basis updating/).count();
      if (pending === 0) return;
      await page.waitForTimeout(1000);
    }
  });
}

async function waitForToast(page: Page, text: RegExp, timeout = 180_000): Promise<void> {
  await page.getByRole("status").filter({ hasText: text }).first().waitFor({ timeout });
  await page.waitForTimeout(2500);
}

async function pre(browser: Browser): Promise<void> {
  await card(browser, "01-title", "Meridian", "Binary markets on the daily close. Yes or No, every contract pays $1.00 to the side that wins.");

  // Scene 2: landing + markets (superseded by record-tour.mts's 02a/02b/02c scenes in the showcase cut).
  if (want("02-markets") && ONLY.length > 0) {
    const page = await newPage(browser, "02-markets");
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForTimeout(7000);
    await slowScroll(page, 1400);
    await page.waitForTimeout(1500);
    await page.goto(`${BASE}/markets`, { waitUntil: "load" });
    await page.waitForTimeout(4000);
    const btn = page.getByRole("button", { name: /more strike/ }).first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(2500);
    }
    await finish(page, "02-markets");
  }

  await card(browser, "03-card", "Making a market", "A maker deposits $1.00 to mint a Yes/No pair, then quotes both sides on the order book.");

  // Scene 4: maker mints and quotes on Portfolio.
  if (want("04-maker")) {
    const page = await newPage(browser, "04-maker", MAKER);
    await page.goto(`${BASE}/portfolio`, { waitUntil: "load" });
    await connect(page);
    await page.waitForTimeout(3000); // let positions and each market's token program resolve
    await waitForHistory(page, "04-maker");
    await page.waitForTimeout(2000);
    const quotes = page.getByRole("heading", { name: "Your quotes" });
    await quotes.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);
    const mintSelect = page.getByLabel(/^Market/).first();
    const optionLabel = (await mintSelect.locator("option").allInnerTexts()).find((o) => o.includes(TICKER) && o.includes(STRIKE));
    if (optionLabel) await mintSelect.selectOption({ label: optionLabel });
    await page.waitForTimeout(800);
    await page.getByLabel(/Pairs to mint/).fill("5");
    await page.waitForTimeout(600);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await page.getByRole("button", { name: "Mint pair", exact: true }).click();
      let outcome = "timeout";
      await skip(page, "04-maker", async () => {
        outcome = await Promise.race([
          page.getByRole("status").filter({ hasText: /Minted/ }).first().waitFor({ timeout: 120_000 }).then(() => "ok"),
          page.getByText("Still checking this market").waitFor({ timeout: 120_000 }).then(() => "retry"),
        ]).catch(() => "timeout");
      });
      if (outcome === "ok") break;
      if (outcome === "retry") { await page.waitForTimeout(5000); continue; }
      break;
    }
    await page.waitForTimeout(2500);
    // Quotes: offer to sell 5 Yes at 0.55 and to buy 5 Yes at 0.45, queued then submitted together.
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Add to queue" }) }).first();
    await form.scrollIntoViewIfNeeded();
    const strikeSelect = form.getByLabel(/^Strike/);
    const strikeLabel = (await strikeSelect.locator("option").allInnerTexts()).find((o) => o.includes(TICKER) && o.includes(STRIKE));
    if (strikeLabel) await strikeSelect.selectOption({ label: strikeLabel });
    const addButton = form.getByRole("button", { name: "Add to queue" });
    await addButton.waitFor({ state: "visible" });
    await skip(page, "04-maker", async () => {
      for (let i = 0; i < 60 && !(await addButton.isEnabled()); i += 1) await page.waitForTimeout(1000);
    });
    // The ask needs the freshly minted Yes to show up in the form's balance, which
    // lags the mint confirmation by a few seconds; the retries (and their wait) are
    // cut from the footage, so only the attempt that queues is seen.
    for (const [side, price, rowText] of [["Offer to sell Yes at", ASK, "Sell Yes"], ["Offer to buy Yes at", BID, "Buy Yes"]] as const) {
      await form.getByLabel(/^Side/).selectOption({ label: side });
      await page.waitForTimeout(400);
      await form.getByLabel(/^Price/).fill(price);
      await form.getByLabel(/^Quantity/).fill("5");
      await page.waitForTimeout(700);
      let queued = false;
      for (let attempt = 0; attempt < 20 && !queued; attempt += 1) {
        await addButton.click();
        queued = await page.locator("tr", { hasText: rowText }).filter({ hasText: `$${price}` }).first()
          .waitFor({ timeout: 2500 }).then(() => true).catch(() => false);
        if (!queued) await skip(page, "04-maker", () => page.waitForTimeout(3000));
      }
      await page.waitForTimeout(900);
    }
    await page.getByRole("button", { name: "Submit queued quotes" }).click();
    await skip(page, "04-maker", () => waitForToast(page, /Quotes placed/).catch(() => page.waitForTimeout(120_000)));
    await page.waitForTimeout(2500);
    await finish(page, "04-maker");
  }

  await card(browser, "05-card", "Taking a side", "A second wallet buys Yes at the quoted price. Chance is the Yes price; payout is $1.00 if right.");

  // Scene 6: taker buys Yes on the Trade page.
  if (want("06-taker")) {
    const page = await newPage(browser, "06-taker", TAKER);
    await page.goto(`${BASE}/trade/${TICKER}?strike=${STRIKE}`, { waitUntil: "load" });
    await page.waitForTimeout(5000);
    await connect(page);
    await page.waitForTimeout(2500);
    await page.getByLabel(/Quantity/).fill(QTY);
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Buy Yes", exact: true }).click();
    await skip(page, "06-taker", () => waitForToast(page, /Bought/).catch(() => page.waitForTimeout(90_000)));
    await page.waitForTimeout(2000);
    await page.goto(`${BASE}/portfolio`, { waitUntil: "load" });
    await page.waitForTimeout(2500);
    await waitForHistory(page, "06-taker");
    await page.waitForTimeout(4000);
    await finish(page, "06-taker");
  }

  await card(browser, "07-card", "The close", "Trading stops at the close. The settlement service posts the Pyth price on chain and settles every market.", 4);
}

async function post(browser: Browser): Promise<void> {
  // Scene 8: settled markets and redemption.
  if (want("08-settled")) {
    const page = await newPage(browser, "08-settled", TAKER);
    await page.goto(`${BASE}/markets`, { waitUntil: "load" });
    await page.waitForTimeout(4000);
    await page.goto(`${BASE}/trade/${TICKER}?strike=${STRIKE}`, { waitUntil: "load" });
    await page.waitForTimeout(4000);
    await page.goto(`${BASE}/portfolio`, { waitUntil: "load" });
    await connect(page);
    await page.waitForTimeout(2500);
    await waitForHistory(page, "08-settled");
    await page.waitForTimeout(2500);
    const redeem = page.getByRole("button", { name: /Redeem winning|Redeem all/ }).first();
    if (await redeem.count()) {
      await redeem.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      await redeem.click();
      await skip(page, "08-settled", () => waitForToast(page, /Collected/).catch(() => page.waitForTimeout(90_000)));
    }
    await page.waitForTimeout(2500);
    await page.goto(`${BASE}/history`, { waitUntil: "load" });
    await page.waitForTimeout(4000);
    await finish(page, "08-settled");
  }
  await card(browser, "09-end", "Non-custodial, on-chain, settled by oracle", "Program, order book, settlement and redemption on Solana devnet. Docs in the app.", 4);
}

const browser = await chromium.launch();
if (PHASE === "pre") await pre(browser);
else await post(browser);
await browser.close();
const cutsPath = join(OUT, "cuts.json");
const existing = existsSync(cutsPath) ? (JSON.parse(readFileSync(cutsPath, "utf8")) as Record<string, Array<[number, number]>>) : {};
writeFileSync(cutsPath, JSON.stringify({ ...existing, ...cuts }, null, 2));
console.log("cuts", JSON.stringify(cuts));
writeFileSync(join(OUT, `phase-${PHASE}.done`), new Date().toISOString());
console.log("phase", PHASE, "recorded to", OUT);
